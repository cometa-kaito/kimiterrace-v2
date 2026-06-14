import type { ListParams } from "@/app/_components/datalist/list-params";
import { type TenantTx, ads, advertisers, events } from "@kimiterrace/db";
import { type SQL, and, eq, gte, lt, sql } from "drizzle-orm";

/**
 * 運営整理 §4 item2 / UIUX-03: 全校ダッシュボード (`/ops/dashboard`) の **企業別 / 枠別** 集計層。
 *
 * 学校別 (`dashboard-stats.ts`) に加え、運営が「どの企業 (広告主)」「どの枠 (広告 = 配信割当)」に
 * 反応が集まっているかを横断把握するための集計。**モニタ別**は events にデバイス識別子が無いため本スライス
 * では実装せず別 issue (#916) に切り出す (要 schema + ingestion + signage client)。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く (`dashboard-stats.ts` と同じ規律)。テーブルは
 * barrel から import し、行型は集計用のビューモデル (テーブル行ではない射影) として本ファイルに定義する。
 *
 * ## events → ad → advertiser の結合 (ルール4)
 * view/tap/ask イベントは `events.payload->>'adId'` に広告 id を持つ (`event-ingest.ts`)。`ads.id::text` と
 * 突合し (`ad-reach.ts` と同方式・**未検証 payload を uuid へキャストしない**安全側)、`ads.advertiser_id` 経由で
 * 広告主へ辿る。ads.id / advertisers.id は一意なので event 1 行に最大 1 行で fan-out せず、`count(*)` は
 * イベント数を正しく数える。集計は件数のみで `payload` の匿名 clientId 等は読まない。
 *
 * ## テナント分離 (ルール2)
 * `school_id` / role の WHERE は書かない — events / ads / advertisers の RLS に委譲する。system_admin
 * コンテキスト (`withSession`) で `system_admin_full_access` が全校行に発火し横断集計になる。
 *
 * ## JST 境界 (#341 の罠回避)
 * 期間境界は呼び出し側が `dateRangeBounds` で組んだ絶対時刻 (Date) を渡す。SQL 側で日付演算しない。
 */

type Selectable = Pick<TenantTx, "select">;

/** 企業 (広告主) 別の反応サマリー。 */
export type AdvertiserEventSummary = {
  advertiserId: string;
  companyName: string;
  totals: { view: number; tap: number; ask: number };
  reactions: number;
};

/** 枠 (広告 = 配信割当) 別の反応サマリー。caption / companyName は表示ラベル (削除済 / 未設定は null)。 */
export type AdEventSummary = {
  adId: string;
  caption: string | null;
  companyName: string | null;
  totals: { view: number; tap: number; ask: number };
  reactions: number;
};

/** 期間境界 (since 含む / untilExclusive 排他) を events.occurred_at の条件に変換する。 */
function rangeConditions(range: { since: Date | null; untilExclusive: Date | null }): SQL[] {
  // adId を持つ反応イベントのみ対象 (掲示に紐づかない一般 Q&A 等は広告に帰属しない)。
  const conditions: SQL[] = [sql`${events.payload}->>'adId' is not null`];
  if (range.since) {
    conditions.push(gte(events.occurredAt, range.since));
  }
  if (range.untilExclusive) {
    conditions.push(lt(events.occurredAt, range.untilExclusive));
  }
  return conditions;
}

const viewCount = sql<number>`count(*) filter (where ${events.type} = 'view')`.mapWith(Number);
const tapCount = sql<number>`count(*) filter (where ${events.type} = 'tap')`.mapWith(Number);
const askCount = sql<number>`count(*) filter (where ${events.type} = 'ask')`.mapWith(Number);
// 反応数 = view + tap (ask は別指標、dashboard-stats.ts と同方針)。
const reactionCount =
  sql<number>`count(*) filter (where ${events.type} in ('view', 'tap'))`.mapWith(Number);
// 並びの決定性: 反応数降順を SQL でも組む (メモリ内 sort 前の既定順)。
const reactionDesc = sql`count(*) filter (where ${events.type} in ('view', 'tap')) desc`;

/** 広告 id 突合の join 条件 (payload を uuid へキャストしない安全側、ad-reach.ts と同方式)。 */
const adJoinOn = sql`${ads.id}::text = ${events.payload}->>'adId'`;

/**
 * **全校横断**で企業 (広告主) 別の反応サマリーを期間指定で集計する (system_admin 専用、RLS 委譲)。
 * 広告主に紐づく広告 (`ads.advertiser_id`) への反応のみを企業へ帰属させる (INNER JOIN advertisers)。
 */
export async function getEventStatsByAdvertiserRange(
  db: Selectable,
  range: { since: Date | null; untilExclusive: Date | null },
): Promise<AdvertiserEventSummary[]> {
  const rows = await db
    .select({
      advertiserId: advertisers.id,
      companyName: advertisers.companyName,
      views: viewCount,
      taps: tapCount,
      asks: askCount,
      reactions: reactionCount,
    })
    .from(events)
    .innerJoin(ads, adJoinOn)
    .innerJoin(advertisers, eq(ads.advertiserId, advertisers.id))
    .where(and(...rangeConditions(range)))
    .groupBy(advertisers.id, advertisers.companyName)
    .orderBy(reactionDesc, advertisers.companyName, advertisers.id);

  return rows.map((r) => ({
    advertiserId: r.advertiserId,
    companyName: r.companyName,
    totals: { view: r.views, tap: r.taps, ask: r.asks },
    reactions: r.reactions,
  }));
}

/**
 * **全校横断**で枠 (広告) 別の反応サマリーを期間指定で集計する (system_admin 専用、RLS 委譲)。
 * 広告主未設定の広告も含めるため advertisers は LEFT JOIN (companyName は null になりうる)。
 */
export async function getEventStatsByAdRange(
  db: Selectable,
  range: { since: Date | null; untilExclusive: Date | null },
): Promise<AdEventSummary[]> {
  const rows = await db
    .select({
      adId: ads.id,
      caption: ads.caption,
      companyName: advertisers.companyName,
      views: viewCount,
      taps: tapCount,
      asks: askCount,
      reactions: reactionCount,
    })
    .from(events)
    .innerJoin(ads, adJoinOn)
    .leftJoin(advertisers, eq(ads.advertiserId, advertisers.id))
    .where(and(...rangeConditions(range)))
    .groupBy(ads.id, ads.caption, advertisers.companyName)
    .orderBy(reactionDesc, ads.id);

  return rows.map((r) => ({
    adId: r.adId,
    caption: r.caption,
    companyName: r.companyName,
    totals: { view: r.views, tap: r.taps, ask: r.asks },
    reactions: r.reactions,
  }));
}

/** 企業別テーブルの列ソート allowlist。 */
export const ADVERTISER_SORT_KEYS = ["companyName", "view", "tap", "ask", "reactions"] as const;

/** 枠別テーブルの列ソート allowlist。 */
export const AD_SORT_KEYS = ["caption", "companyName", "view", "tap", "ask", "reactions"] as const;

function totalsSortValue(
  totals: { view: number; tap: number; ask: number },
  reactions: number,
  key: string,
): number | null {
  switch (key) {
    case "view":
      return totals.view;
    case "tap":
      return totals.tap;
    case "ask":
      return totals.ask;
    case "reactions":
      return reactions;
    default:
      return null;
  }
}

/** 企業別サマリーを **メモリ内**で並べ替える (非破壊)。同値は会社名 → id 昇順で決定的。 */
export function sortAdvertiserSummaries(
  rows: readonly AdvertiserEventSummary[],
  params: Pick<ListParams, "sort" | "dir">,
): AdvertiserEventSummary[] {
  const sign = params.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const na = totalsSortValue(a.totals, a.reactions, params.sort);
    const nb = totalsSortValue(b.totals, b.reactions, params.sort);
    const primary =
      na !== null && nb !== null ? na - nb : a.companyName.localeCompare(b.companyName, "ja");
    if (primary !== 0) {
      return primary * sign;
    }
    return (
      a.companyName.localeCompare(b.companyName, "ja") ||
      a.advertiserId.localeCompare(b.advertiserId)
    );
  });
}

/** 枠別サマリーを **メモリ内**で並べ替える (非破壊)。同値は id 昇順で決定的。 */
export function sortAdSummaries(
  rows: readonly AdEventSummary[],
  params: Pick<ListParams, "sort" | "dir">,
): AdEventSummary[] {
  const sign = params.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let primary: number;
    if (params.sort === "caption") {
      primary = (a.caption ?? "").localeCompare(b.caption ?? "", "ja");
    } else if (params.sort === "companyName") {
      primary = (a.companyName ?? "").localeCompare(b.companyName ?? "", "ja");
    } else {
      const na = totalsSortValue(a.totals, a.reactions, params.sort) ?? 0;
      const nb = totalsSortValue(b.totals, b.reactions, params.sort) ?? 0;
      primary = na - nb;
    }
    if (primary !== 0) {
      return primary * sign;
    }
    return a.adId.localeCompare(b.adId);
  });
}
