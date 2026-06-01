import { and, eq, gte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { events } from "../schema/events.js";

/**
 * F07/F09 (#322): 広告到達数 (advertiser reach) の集計読み取り層。**SELECT のみ**。
 *
 * [ADR-025](../../../../docs/adr/025-impression-reach-counting-semantics.md) が定めた
 * **到達数 = 集計時に `(client_id, ad_id, JST 分)` で重複排除した impressions** を実装する。
 * F08 の `getEventStats.totals.view` (= 延べ表示数 / engagement, `count(*)`) とは**別指標**で、
 * 広告主向け月次レポート (F09) の「到達数」はこちらを使う。素の延べ件数を到達数として出さない。
 *
 * ## なぜ集計時 dedup か (取り込みは append-only のまま)
 * beacon は冪等性を持たず (クライアント側リトライなし、event-logging.md)、取り込みは append-only
 * ベストエフォート。重複排除は本クエリの DISTINCT で後段吸収する。これにより表示枚数・ローテーション
 * 速度・端末稼働時間で到達数が水増しされない (ADR-025 の anti-inflation 方針)。
 *
 * ## dedup キーと粒度
 * - **ad_id**: `payload->>'adId'` (events.content_id は contents への FK なので広告 id は payload に持つ)。
 * - **client_id**: `payload->>'clientId'` (localStorage 由来の匿名 uuid、個人特定情報ではない / ルール4)。
 * - **JST 分**: `occurred_at` (DB now() 由来、クライアント時刻不信) を Asia/Tokyo の分に丸める。
 *   分粒度なので「同一端末が長時間表示」は分単位で到達計上され (露出量を反映)、同一分内の重複
 *   (ハートビート二重・ローテ一周即時復帰) は 1 に集約される。
 *
 * ## client_id 欠落 (NULL) の扱い — ADR-025 follow-up の確定
 * localStorage 不可端末は `payload->>'clientId'` が NULL になり端末識別できない。**同一 `(ad_id, JST 分)`
 * 内の clientId 欠落 view は 1 到達に集約**する (`coalesce(..., '')` で空キーに寄せる)。複数の匿名端末を
 * 取りこぼす過少側に倒すが、広告主への報告値を膨らませない anti-inflation を優先する (ADR-025)。
 *
 * ## テナント分離 (ルール2)
 * `school_id` 条件は**書かない** — 呼び出し接続の RLS コンテキスト (app.current_school_id、ADR-019) が
 * events の `tenant_isolation` で SELECT を自校行に絞る。`db` は非 BYPASSRLS の kimiterrace_app 接続を使う。
 * 返すのは件数のみで `payload` の生値 (clientId 等) は出さない (ルール4)。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** 広告 1 件あたりの到達数 (= 重複排除済 impressions)。 */
export type AdReach = {
  /** 広告 id (payload.adId)。 */
  adId: string;
  /** `(client_id, JST 分)` で重複排除した到達数。 */
  reach: number;
};

const DEFAULT_SINCE_DAYS = 30;

// `(client_id, JST 分)` の重複排除キー。clientId 欠落は空文字に寄せて同一分内で 1 到達に集約する。
const reachKey = (occurredAt: typeof events.occurredAt, payload: typeof events.payload) =>
  sql`(coalesce(${payload}->>'clientId', ''), date_trunc('minute', ${occurredAt} at time zone 'Asia/Tokyo'))`;

/**
 * 自校の広告到達数を広告別に集計する (RLS で school スコープ)。到達数降順 → adId 昇順で決定的に並べる。
 *
 * 対象は `type='view'` かつ `payload->>'adId'` を持つ広告 impression のみ (tap や広告以外の view は除外)。
 *
 * @param opts.sinceDays 集計対象の遡及日数 (既定 30)。期間窓は DB の `now()` 基準 (クライアント時刻不信)。
 */
export async function getAdReach(
  db: Selectable,
  opts: { sinceDays?: number } = {},
): Promise<AdReach[]> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
  const recent = gte(events.occurredAt, sql`now() - make_interval(days => ${sinceDays}::int)`);

  const adId = sql<string>`${events.payload}->>'adId'`;
  const reach = sql<number>`count(distinct ${reachKey(events.occurredAt, events.payload)})`.mapWith(
    Number,
  );

  const rows = await db
    .select({ adId, reach })
    .from(events)
    .where(and(eq(events.type, "view"), recent, sql`${events.payload}->>'adId' is not null`))
    .groupBy(adId)
    // 到達数同数でも順序を決定的にするため adId を二次キーにする。
    .orderBy(
      sql`count(distinct ${reachKey(events.occurredAt, events.payload)}) desc`,
      sql`${events.payload}->>'adId'`,
    );

  return rows.map((r) => ({ adId: r.adId, reach: r.reach }));
}
