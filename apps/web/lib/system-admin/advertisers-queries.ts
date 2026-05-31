import { type TenantTx, advertisers } from "@kimiterrace/db";
import { type InferSelectModel, asc, desc } from "drizzle-orm";

/**
 * F10 (#46): 広告主マスタ (CRM) の読み取り層。**サーバー専用**。
 *
 * advertisers は **cross-tenant・system_admin 専用** (RLS `system_admin_full_access`、ADR-018/019)。
 * 呼び出し側は `requireRole(SYSTEM_ADMIN_ROLES)` + `withSession` (system_admin context) で RLS を
 * 満たすこと — 本層は `WHERE` を手書きせず、可視範囲は RLS が決める (ルール2)。
 *
 * **クエリの置き場所**: 通常マスタは `packages/db/src/queries/*` に置くが、本スライスは
 * `apps/web` に inline する。`packages/db` の barrel (`index.ts`) を触る並行レーン (F08 #264 等) との
 * 衝突を避けるためで、型は advertisers スキーマ由来 (`InferSelectModel`) のままなので**単一ソースは維持**
 * する (ルール3)。barrel が空いたら packages/db 側へ昇格してよい。
 */

/**
 * 一覧 1 行の軽量射影。識別 + ステータス + 主担当連絡先に絞る (住所・電話・備考は詳細ビューに回す)。
 * いずれも営業上のビジネス情報で生徒 PII ではない (ルール4 の対象外)。
 */
export type AdvertiserSummary = Pick<
  InferSelectModel<typeof advertisers>,
  "id" | "companyName" | "industry" | "contactEmail" | "isActive" | "createdAt"
>;

/**
 * 広告主一覧を返す。並びは**稼働中 (is_active) を先頭**に、会社名昇順
 * (`ix_advertisers_company_name` を利用)。論理削除済 (is_active=false) も末尾に残し、過去契約の
 * トレース用に閲覧できるようにする (物理 DELETE しない方針、advertisers schema doc)。
 */
export async function listAdvertisers(tx: TenantTx): Promise<AdvertiserSummary[]> {
  return await tx
    .select({
      id: advertisers.id,
      companyName: advertisers.companyName,
      industry: advertisers.industry,
      contactEmail: advertisers.contactEmail,
      isActive: advertisers.isActive,
      createdAt: advertisers.createdAt,
    })
    .from(advertisers)
    .orderBy(desc(advertisers.isActive), asc(advertisers.companyName));
}
