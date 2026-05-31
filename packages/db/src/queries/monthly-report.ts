import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { contents } from "../schema/contents.js";
import { events } from "../schema/events.js";
import type { ContentEngagement, EventTotals } from "./event-stats.js";

/**
 * F09 (#45): 月次レポートの集計読み取り層 (第1スライス: **学校別サマリー**)。**SELECT のみ**。
 *
 * F07 (#43) が `events` に記録した行動ログを、**JST 暦月**ごとに 1 校分のサマリーへ集計する。
 * 教員向けの「サイネージ全体の活動サマリー」(F09 受け入れ条件) に対応する自校ビュー。広告主別
 * レポート (広告単位の到達/タップ/Q&A) と PDF 生成・`monthly_reports` 履歴・Cloud Storage 保存は
 * 後続スライスで追加する。mutation は持たない参照専用モジュール。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト (`app.current_school_id`、
 * ADR-019) が DB レベルでテナント境界を強制する。呼び出し側 (apps/web の `withSession`) が RLS
 * context を張った接続/トランザクションで実行し、`db` には RLS をバイパスしない接続ロール
 * (kimiterrace_app) を使うこと。`events` の `tenant_isolation` policy が SELECT を自校行に絞る
 * ため、集計結果も自校スコープになる。content 結合先 `contents` も同 policy で絞られる。
 *
 * ## 期間境界 (JST 暦月)
 * 対象月の窓は **Asia/Tokyo の暦月** `[当月 1 日 00:00 JST, 翌月 1 日 00:00 JST)` で評価する。
 * 境界は `make_timestamptz(year, month, 1, 0, 0, 0, 'Asia/Tokyo')` として **DB 側で int から
 * 構築**する。JS の `Date` を timestamptz パラメータに bind しない (postgres@3.4.9 が enum 列を
 * 含む文脈で Date を直列化できない既知の罠を回避し、年/月を int で渡す getEventStats と同じ思想)。
 * UTC のまま月境界を取ると JST 深夜帯 (例 JST 1 日 08:00 = UTC 前月末日 23:00) の event が前月へ
 * ずれるため、日本の学校向けに JST 暦月へ寄せる。
 *
 * ## PII / 監査 (ルール4 / NFR04)
 * 集計は件数 (整数)・content タイトル・稼働日数のみを返し、`events.payload` の匿名 clientId 等は
 * 読み出さない。個人を再識別しうる粒度 (端末別/個人別) には落とさない。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** 学校別 月次レポート 1 枚分の read モデル。 */
export type MonthlySchoolSummary = {
  /** 対象年 (西暦)。 */
  year: number;
  /** 対象月 (1-12)。 */
  month: number;
  /** view / tap / ask の月内総数。 */
  totals: EventTotals;
  /** 反応の多い content 上位。total 降順、同数は title 昇順 → contentId 昇順で決定的に並べる。 */
  ranking: ContentEngagement[];
  /** 月内に 1 件以上 event があった **JST 暦日**の数 (= サイネージの稼働日数)。 */
  activeDays: number;
};

const DEFAULT_RANKING_LIMIT = 10;
const MIN_MONTH = 1;
const MAX_MONTH = 12;

/**
 * 自校の行動ログを **JST 暦月**で集計し、学校別 月次サマリーを返す (RLS で school スコープ)。
 *
 * @param opts.year 対象年 (西暦、例 2026)。
 * @param opts.month 対象月 (1-12)。範囲外は `RangeError`。
 * @param opts.rankingLimit content ランキングの最大件数 (既定 10)。
 */
export async function getMonthlySchoolSummary(
  db: Selectable,
  opts: { year: number; month: number; rankingLimit?: number },
): Promise<MonthlySchoolSummary> {
  const { year, month } = opts;
  // 月は 1-12 のみ受け付ける (make_timestamptz は 13 月等を翌年へ繰り上げてしまい、呼び出し側の
  // 想定とずれるため、ここで明示的に弾く)。year/month は UI からの入力になりうるので範囲検証する。
  if (!Number.isInteger(month) || month < MIN_MONTH || month > MAX_MONTH) {
    throw new RangeError(`month must be an integer in [1, 12], got ${month}`);
  }
  if (!Number.isInteger(year)) {
    throw new RangeError(`year must be an integer, got ${year}`);
  }
  const rankingLimit = opts.rankingLimit ?? DEFAULT_RANKING_LIMIT;

  // JST 暦月の窓 [当月 1 日 00:00 JST, 翌月 1 日 00:00 JST)。境界は DB 側で int から構築する。
  const monthStart = sql`make_timestamptz(${year}::int, ${month}::int, 1, 0, 0, 0, 'Asia/Tokyo')`;
  const nextMonthStart = sql`${monthStart} + interval '1 month'`;
  const inMonth = and(gte(events.occurredAt, monthStart), lt(events.occurredAt, nextMonthStart));

  // --- totals: type 別件数 + 稼働日数 (JST 暦日の distinct) ---
  // 1 クエリで type 別件数と稼働日数を取る。稼働日数は occurred_at を JST 日に丸めた distinct 数。
  const totalRows = await db
    .select({ type: events.type, n: sql<number>`count(*)`.mapWith(Number) })
    .from(events)
    .where(inMonth)
    .groupBy(events.type);
  const totals: EventTotals = { view: 0, tap: 0, ask: 0 };
  for (const row of totalRows) {
    if (row.type === "view") {
      totals.view = row.n;
    } else if (row.type === "tap") {
      totals.tap = row.n;
    } else if (row.type === "ask") {
      totals.ask = row.n;
    }
  }

  // 稼働日数: occurred_at を Asia/Tokyo の暦日へ丸めた distinct 数 (getDailyEventCounts と同じ丸め)。
  const [activeRow] = await db
    .select({
      days: sql<number>`count(distinct date_trunc('day', ${events.occurredAt} at time zone 'Asia/Tokyo'))`.mapWith(
        Number,
      ),
    })
    .from(events)
    .where(inMonth);
  const activeDays = activeRow?.days ?? 0;

  // --- ranking: content 別反応数 (view/tap) ---
  // title を出すため contents を内部結合する。INNER JOIN により content_id が NULL の event は
  // 自然に除外される。ランキングは view/tap の反応で並べ、`total = count(*)` が views + taps と
  // 一致する (ask は totals 側にのみ計上、getEventStats と同方針)。
  const reactions = and(inMonth, inArray(events.type, ["view", "tap"]));
  const views = sql<number>`count(*) filter (where ${events.type} = 'view')`.mapWith(Number);
  const taps = sql<number>`count(*) filter (where ${events.type} = 'tap')`.mapWith(Number);
  const total = sql<number>`count(*)`.mapWith(Number);
  const rankRows = await db
    .select({ contentId: events.contentId, title: contents.title, views, taps, total })
    .from(events)
    .innerJoin(contents, eq(events.contentId, contents.id))
    .where(reactions)
    .groupBy(events.contentId, contents.title)
    // total 同数でも順序を決定的にするため title → contentId を二次/三次キーにする。
    .orderBy(sql`count(*) desc`, contents.title, events.contentId)
    .limit(rankingLimit);

  const ranking: ContentEngagement[] = rankRows.map((r) => ({
    // INNER JOIN により contentId は非 NULL。型の都合で narrow する。
    contentId: r.contentId as string,
    title: r.title,
    views: r.views,
    taps: r.taps,
    total: r.total,
  }));

  return { year, month, totals, ranking, activeDays };
}
