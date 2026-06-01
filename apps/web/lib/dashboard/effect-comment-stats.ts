import type { EffectCommentStats, EffectMetric, EffectTopContent } from "@kimiterrace/ai";
import { type TenantTx, contents, events } from "@kimiterrace/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";

/**
 * F08 (#44, slice 2): AI 効果コメント生成の **入力集計**（自校・**当月 vs 前月**）。**SELECT のみ**。
 *
 * 効果ダッシュボード (`getEventStats` / `getMonthlySchoolSummary`) と同じ `events` 行動ログから、
 * `@kimiterrace/ai` の {@link EffectCommentStats}（{@link buildEffectCommentPrompt} の入力契約）を
 * 組み立てる。AI コメントは「今月の反応を前月と比べて要約」するため、指標は **当月件数 + 前月件数**、
 * topContent は **当月の反応上位**を返す。
 *
 * ## 置き場所（並行レーン回避）
 * `packages/db` (chokepoint) を編集せず、`communications-queries.ts` と同様に `apps/web` 側へ inline
 * する。テーブル import は barrel 経由でも `packages/db` の **ソースは触らない**（型は schema 由来の
 * まま、ルール3）。集計関数 = 純 SELECT、mutation・LLM 呼び出しは action 層（effect-comment-action）。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト (`app.current_school_id`、ADR-019)
 * が DB レベルでテナント境界を強制する。呼び出し側 (`effect-comment-action` の `withSession`) が RLS
 * context tx を張り、非 BYPASSRLS ロール (`kimiterrace_app`) で実行すること。`events` / 結合先
 * `contents` の `tenant_isolation` policy が SELECT を自校行に絞るため、集計も自校スコープになる。
 *
 * ## 期間境界 (JST 暦月) — 既知の罠回避 (#341)
 * 当月・前月の窓は **Asia/Tokyo の暦月**で評価し、境界は `make_timestamptz(y, m, 1, 0,0,0,
 * 'Asia/Tokyo')` として **DB 側で int から構築**する。`monthStart + interval '1 month'` は timestamptz
 * を**セッション TZ** で月加算するため、CI/本番 (UTC セッション) では JST 月初 (= 前月末 15:00 UTC) に
 * 対して月末側へずれ、JST 月末数日を取りこぼす (`getMonthlySchoolSummary` と同じ修正方針)。当月・前月・
 * 翌月の 3 境界とも JS 側で年跨ぎ (1 月→前年 12 月 / 12 月→翌年 1 月) を解いて明示構築する (int 渡しは
 * 維持、JS の Date は bind しない)。
 *
 * ## PII / 監査 (ルール4)
 * 集計は件数 (整数) と content タイトルのみを返し、`events.payload` の匿名 clientId 等は読まない。
 * **タイトルは生 (unmasked) のまま返す** — マスキングは Vertex 送信を担う action 層が辞書を所有して
 * 行う (ルール4 のマスク責務を呼び出し境界に集約)。本層は個人別/端末別の粒度には落とさない。
 */

/** SELECT だけできれば良い (TenantTx を受ける)。 */
type Selectable = Pick<TenantTx, "select">;

const MIN_MONTH = 1;
const MAX_MONTH = 12;
const DEFAULT_TOP_LIMIT = 5;

/** ある JST 暦月の view/tap/ask 件数 + 反応上位 content (生タイトル)。 */
type MonthAggregate = {
  totals: { view: number; tap: number; ask: number };
  topContent: { title: string; reactions: number }[];
};

/** `make_timestamptz` 用に 1 か月ずらした年/月を返す (年跨ぎを JS 側で解く)。 */
function shiftYearMonth(
  year: number,
  month: number,
  delta: -1 | 1,
): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

/** ある JST 暦月 `[year-month 1 日 00:00 JST, 翌月 1 日 00:00 JST)` の集計を 1 校分取る。 */
async function aggregateMonth(
  db: Selectable,
  year: number,
  month: number,
  topLimit: number,
): Promise<MonthAggregate> {
  const next = shiftYearMonth(year, month, 1);
  const monthStart = sql`make_timestamptz(${year}::int, ${month}::int, 1, 0, 0, 0, 'Asia/Tokyo')`;
  const nextMonthStart = sql`make_timestamptz(${next.year}::int, ${next.month}::int, 1, 0, 0, 0, 'Asia/Tokyo')`;
  const inMonth = and(gte(events.occurredAt, monthStart), lt(events.occurredAt, nextMonthStart));

  // --- totals: type 別件数 ---
  const totalRows = await db
    .select({ type: events.type, n: sql<number>`count(*)`.mapWith(Number) })
    .from(events)
    .where(inMonth)
    .groupBy(events.type);
  const totals = { view: 0, tap: 0, ask: 0 };
  for (const row of totalRows) {
    if (row.type === "view") totals.view = row.n;
    else if (row.type === "tap") totals.tap = row.n;
    else if (row.type === "ask") totals.ask = row.n;
  }

  // --- topContent: content 別反応数 (view + tap)、反応降順 ---
  // INNER JOIN で content_id NULL の event を除外。結合先 contents も RLS で自校に絞られる。
  // 同数でも順序を決定的にするため title → contentId を二次/三次キーにする (getEventStats と同方針)。
  const reactions = and(inMonth, inArray(events.type, ["view", "tap"]));
  const reactionCount = sql<number>`count(*)`.mapWith(Number);
  const topRows = await db
    .select({ contentId: events.contentId, title: contents.title, reactions: reactionCount })
    .from(events)
    .innerJoin(contents, eq(events.contentId, contents.id))
    .where(reactions)
    .groupBy(events.contentId, contents.title)
    .orderBy(sql`count(*) desc`, contents.title, events.contentId)
    .limit(topLimit);

  return {
    totals,
    topContent: topRows.map((r) => ({ title: r.title, reactions: r.reactions })),
  };
}

/** `YYYY-MM` ラベル (月ゼロ埋め)。{@link EffectCommentStats.month} 用。 */
function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * 自校の **当月 vs 前月** 行動ログを集計し、AI 効果コメントの入力 ({@link EffectCommentStats}) を返す。
 *
 * - metrics: 閲覧 (view) / タップ (tap) / Q&A (ask) の 3 指標。`current` = 当月件数、`previous` = 前月件数。
 *   前月窓に 1 件も event が無くても件数 0 は確定値として返せるため、`previous` は常に数値 (null は
 *   builder が「前月データなし」を出す将来拡張用の許容値で、本集計では使わない)。
 * - topContent: **当月**の反応上位 content (view + tap 降順)。タイトルは **生のまま** (マスクは action 層)。
 * - 空月 (当月に event 無し) は metrics が全 0、topContent は空配列になる。
 *
 * @param opts.year  当月の年 (西暦)。
 * @param opts.month 当月の月 (1-12)。範囲外は `RangeError`。
 * @param opts.topLimit topContent の最大件数 (既定 5)。
 */
export async function getEffectCommentStats(
  db: Selectable,
  opts: { year: number; month: number; topLimit?: number },
): Promise<EffectCommentStats> {
  const { year, month } = opts;
  if (!Number.isInteger(month) || month < MIN_MONTH || month > MAX_MONTH) {
    throw new RangeError(`month must be an integer in [1, 12], got ${month}`);
  }
  if (!Number.isInteger(year)) {
    throw new RangeError(`year must be an integer, got ${year}`);
  }
  const topLimit = opts.topLimit ?? DEFAULT_TOP_LIMIT;
  const prev = shiftYearMonth(year, month, -1);

  // 当月 (topContent あり) と前月 (件数のみ必要だが同関数で取得) を別々に集計する。
  const current = await aggregateMonth(db, year, month, topLimit);
  const previous = await aggregateMonth(db, prev.year, prev.month, topLimit);

  const metrics: EffectMetric[] = [
    { label: "閲覧", current: current.totals.view, previous: previous.totals.view },
    { label: "タップ", current: current.totals.tap, previous: previous.totals.tap },
    { label: "Q&A", current: current.totals.ask, previous: previous.totals.ask },
  ];
  const topContent: EffectTopContent[] = current.topContent.map((c) => ({
    title: c.title,
    reactions: c.reactions,
  }));

  return { month: monthLabel(year, month), metrics, topContent };
}
