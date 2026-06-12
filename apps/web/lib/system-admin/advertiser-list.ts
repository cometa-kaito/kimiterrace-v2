import { type TenantTx, advertisers } from "@kimiterrace/db";
import { type SQL, and, asc, count, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import {
  type ListParams,
  dateRangeBounds,
  escapeLike,
  pageWindow,
} from "@/app/admin/_components/datalist/list-params";
import { isAdvertiserStatus } from "@/lib/system-admin/advertisers-core";
import type { AdvertiserSummary } from "@/lib/system-admin/advertisers-queries";

/**
 * UIUX-03: 広告主一覧 (`/admin/system/advertisers`) のページング/検索/ソート対応 SELECT 層。
 * `school-list.ts` と同構造 (共通 DataList 基盤の適用)。
 *
 * ## 置き場所 (並行レーン回避)
 * `packages/db` (chokepoint) を編集せず `apps/web/lib` に置く (`advertisers-queries.ts` と同じ規律)。
 * テーブルは barrel から import し、型は advertisers スキーマ由来の `AdvertiserSummary` を再利用する
 * (ルール3: 単一ソース維持)。
 *
 * ## テナント分離 (ルール2)
 * advertisers は cross-tenant・system_admin 専用 (RLS `system_admin_full_access`、ADR-018/019)。
 * `school_id` / role の WHERE は書かない — 呼び出し側 (`withSession`) が張る RLS コンテキストが
 * 可視範囲を決める。WHERE は検索条件 (q / status / 登録日範囲) のみ。
 */

type Selectable = Pick<TenantTx, "select">;

/** ソート可能列の allowlist。`parseListParams` の sortKeys と ORDER BY を 1 箇所で対応させる。 */
export const ADVERTISER_SORT_COLUMNS = {
  companyName: advertisers.companyName,
  industry: advertisers.industry,
  status: advertisers.status,
  createdAt: advertisers.createdAt,
} as const;

export const ADVERTISER_SORT_KEYS = Object.keys(ADVERTISER_SORT_COLUMNS) as readonly string[];

/**
 * 一覧 1 ページ分 + ヘッダ集計。`activeTotal` はページ内ではなく**検索条件で絞った全体**の稼働
 * (is_active) 件数 (従来ヘッダの「稼働 N / 全 M 社」をページングしても保つため)。
 */
export type AdvertiserListPage = {
  rows: AdvertiserSummary[];
  total: number;
  activeTotal: number;
};

/**
 * 広告主一覧を検索 (会社名/業種/担当メールの部分一致)・営業ステータスフィルタ・登録日範囲・
 * 列ソート・ページングで取得する。同値ソートでも順序が安定するよう id を最終タイブレークに付ける。
 *
 * 既定の並びは呼び出し側の defaultSort (会社名昇順、`ix_advertisers_company_name` を利用)。従来の
 * 「稼働中を先頭に固定」は列ソート + status フィルタに置き換える (休止も末尾に消えず、過去契約の
 * トレース用に同条件で閲覧できる方針は不変 — 物理 DELETE しない、advertisers schema doc)。
 */
export async function listAdvertisersPage(
  db: Selectable,
  params: ListParams,
): Promise<AdvertiserListPage> {
  const conditions: SQL[] = [];
  if (params.q) {
    const pattern = `%${escapeLike(params.q)}%`;
    const match = or(
      ilike(advertisers.companyName, pattern),
      ilike(advertisers.industry, pattern),
      ilike(advertisers.contactEmail, pattern),
    );
    if (match) {
      conditions.push(match);
    }
  }
  const { since, untilExclusive } = dateRangeBounds(params);
  if (since) {
    conditions.push(gte(advertisers.createdAt, since));
  }
  if (untilExclusive) {
    conditions.push(lt(advertisers.createdAt, untilExclusive));
  }
  // 営業ステータス。membership 検証は enum 由来の isAdvertiserStatus (値域の単一ソース、ルール3)。
  const status = params.filters.status;
  if (status !== undefined && isAdvertiserStatus(status)) {
    conditions.push(eq(advertisers.status, status));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumn =
    ADVERTISER_SORT_COLUMNS[params.sort as keyof typeof ADVERTISER_SORT_COLUMNS] ??
    advertisers.companyName;
  const orderBy =
    params.dir === "asc"
      ? [asc(sortColumn), asc(advertisers.id)]
      : [desc(sortColumn), asc(advertisers.id)];
  const { limit, offset } = pageWindow(params);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: advertisers.id,
        companyName: advertisers.companyName,
        industry: advertisers.industry,
        contactEmail: advertisers.contactEmail,
        status: advertisers.status,
        isActive: advertisers.isActive,
        createdAt: advertisers.createdAt,
      })
      .from(advertisers)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({
        value: count(),
        // CASE WHEN の非 NULL 行だけ数える = 稼働中 (is_active) の件数。
        active: count(sql`case when ${advertisers.isActive} then 1 end`),
      })
      .from(advertisers)
      .where(where),
  ]);

  return {
    rows,
    total: totals[0]?.value ?? 0,
    activeTotal: totals[0]?.active ?? 0,
  };
}
