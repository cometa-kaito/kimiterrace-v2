import { eq, gte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { contents } from "../schema/contents.js";
import { events } from "../schema/events.js";

/**
 * F08 (#44): 効果ダッシュボードの集計読み取り層。**SELECT のみ**。
 *
 * F07 (#43) が `events` に記録した行動ログ (view/tap) を、ダッシュボード 1 枚分に集計する。
 * mutation は持たない参照専用モジュール。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト (`app.current_school_id`、
 * ADR-019) が DB レベルでテナント境界を強制する。呼び出し側 (apps/web の `withSession`) が RLS
 * context を張った接続/トランザクションで実行し、`db` には RLS をバイパスしない接続ロール
 * (kimiterrace_app) を使うこと。`events` の `tenant_isolation` policy が SELECT を自校行に絞る
 * ため、集計結果も自校スコープになる。content 結合先 `contents` も同 policy で絞られる。
 *
 * ## PII / 監査 (ルール4 / NFR04)
 * 集計は件数 (整数) と content タイトルのみを返し、`events.payload` の匿名 clientId 等は読み出さ
 * ない。個人を再識別しうる粒度 (端末別/個人別) には落とさない。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/**
 * 行動種別ごとの件数。本スライスは F07 が実際に記録する **view / tap** のみを面に出す。
 * `dwell` は滞留秒数の計測手段が未確定で Phase 2 まで書き込み不在、`ask` は F06 生徒対話の経路
 * (本ダッシュボードの後続スライスで Q&A 件数として統合) のため、ここでは集計対象外。
 */
export type EventTotals = { view: number; tap: number };

/** content 1 件あたりの反応集計 (ランキング 1 行)。 */
export type ContentEngagement = {
  contentId: string;
  title: string;
  views: number;
  taps: number;
  /** views + taps (= 反応総数)。ランキングの並べ替えキー。 */
  total: number;
};

/** ダッシュボード 1 枚分の read モデル。 */
export type EventStats = {
  /** 集計対象の遡及日数 (DB の now() 基準)。表示の「過去 N 日間」ラベルに使う。 */
  sinceDays: number;
  totals: EventTotals;
  /** 反応の多い content 上位。total 降順、同数は title 昇順 → contentId 昇順で決定的に並べる。 */
  ranking: ContentEngagement[];
};

const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_RANKING_LIMIT = 10;

/**
 * 自校の行動ログを集計する (RLS で school スコープ)。
 *
 * @param opts.sinceDays 集計対象の遡及日数 (既定 30)。期間窓は DB の `now()` 基準で評価し、
 *   クライアント/アプリ時刻を信用しない (F07 と同じ思想、なりすまし/時計ずれ回避)。
 * @param opts.rankingLimit content ランキングの最大件数 (既定 10)。
 */
export async function getEventStats(
  db: Selectable,
  opts: { sinceDays?: number; rankingLimit?: number } = {},
): Promise<EventStats> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const rankingLimit = opts.rankingLimit ?? DEFAULT_RANKING_LIMIT;

  // 期間窓は DB の now() を基準にする。sinceDays は内部既定 or 呼出側の固定値であり、
  // ユーザー入力を直接渡さない (将来 UI から渡す場合は呼出側で範囲検証する)。
  const recent = gte(events.occurredAt, sql`now() - make_interval(days => ${sinceDays}::int)`);

  // --- totals: type 別件数 ---
  const totalRows = await db
    .select({ type: events.type, n: sql<number>`count(*)`.mapWith(Number) })
    .from(events)
    .where(recent)
    .groupBy(events.type);
  const totals: EventTotals = { view: 0, tap: 0 };
  for (const row of totalRows) {
    if (row.type === "view") {
      totals.view = row.n;
    } else if (row.type === "tap") {
      totals.tap = row.n;
    }
  }

  // --- ranking: content 別反応数 ---
  // title を出すため contents を内部結合する。INNER JOIN により content_id が NULL の event
  // (例: 広告枠そのものへの tap) は自然に除外される。結合先 contents も RLS で自校に絞られる。
  const views = sql<number>`count(*) filter (where ${events.type} = 'view')`.mapWith(Number);
  const taps = sql<number>`count(*) filter (where ${events.type} = 'tap')`.mapWith(Number);
  const total = sql<number>`count(*)`.mapWith(Number);
  const rankRows = await db
    .select({ contentId: events.contentId, title: contents.title, views, taps, total })
    .from(events)
    .innerJoin(contents, eq(events.contentId, contents.id))
    .where(recent)
    .groupBy(events.contentId, contents.title)
    // total 同数でも順序を決定的にするため title → contentId を二次/三次キーにする。
    .orderBy(sql`count(*) desc`, contents.title, events.contentId)
    .limit(rankingLimit);

  const ranking: ContentEngagement[] = rankRows.map((r) => ({
    // INNER JOIN により contentId は非 NULL (NULL は結合条件で除外される)。型の都合で narrow する。
    contentId: r.contentId as string,
    title: r.title,
    views: r.views,
    taps: r.taps,
    total: r.total,
  }));

  return { sinceDays, totals, ranking };
}
