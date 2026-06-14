import { type TenantTx, advertisers } from "@kimiterrace/db";
import { type InferSelectModel, asc, desc, eq } from "drizzle-orm";

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
 * 一覧 1 行の軽量射影。識別 + 営業ステータス + 稼働フラグ + 主担当連絡先に絞る (住所・電話・備考は
 * 詳細ビューに回す)。いずれも営業上のビジネス情報で生徒 PII ではない (ルール4 の対象外)。
 *
 * `status` (見込/契約中/休止) と `isActive` は不変条件 (`status='paused' ⟺ is_active=false`) で連動する
 * が、両方を射影してバッジ表示 (status) と並び (isActive) の双方に使う。型は advertisers スキーマ由来
 * (`InferSelectModel`) で単一ソースを維持する (ルール3)。
 */
export type AdvertiserSummary = Pick<
  InferSelectModel<typeof advertisers>,
  "id" | "companyName" | "industry" | "contactEmail" | "status" | "isActive" | "createdAt"
>;

/**
 * 広告主一覧を返す。並びは**稼働中 (is_active) を先頭**に、会社名昇順
 * (`ix_advertisers_company_name` を利用)。休止 (status='paused' ⟺ is_active=false) も末尾に残し、
 * 過去契約のトレース用に閲覧できるようにする (物理 DELETE しない方針、advertisers schema doc)。
 * status は不変条件で is_active と連動するため、並びは従来どおり is_active を主キーに保つ
 * (active/prospect が先頭・paused が末尾)。
 */
export async function listAdvertisers(tx: TenantTx): Promise<AdvertiserSummary[]> {
  return await tx
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
    .orderBy(desc(advertisers.isActive), asc(advertisers.companyName));
}

/**
 * 編集フォームの初期値に使う射影。実装設計書 §4「advertisers/[id]/edit 最小縮退」で編集面を
 * **表示名 (会社名) + 配信ステータス (status)** の 2 項目に絞ったため、業種・連絡先・住所・備考は
 * 射影しない (それらは portal が正で v2 編集では扱わない / データ露出面も縮小)。`status` は配信ステータス
 * セレクトの初期選択 (`toDeliveryStatus`) に使う。is_active は status と不変条件で連動するため含めない。
 */
export type AdvertiserDetail = Pick<
  InferSelectModel<typeof advertisers>,
  "id" | "companyName" | "status"
>;

/**
 * 単一広告主を id で取得する。**WHERE は対象特定であってテナント境界ではない** — 可視範囲は RLS
 * (`system_admin_full_access`) が決め、非 system_admin context では 0 行に倒れる (ルール2)。
 * 見つからなければ `null` (RLS 不可視 / 不存在は呼出側で区別しない、どちらも 404 相当)。
 */
export async function getAdvertiserDetail(
  tx: TenantTx,
  id: string,
): Promise<AdvertiserDetail | null> {
  const [row] = await tx
    .select({
      id: advertisers.id,
      companyName: advertisers.companyName,
      status: advertisers.status,
    })
    .from(advertisers)
    .where(eq(advertisers.id, id))
    .limit(1);
  return row ?? null;
}
