import { type TenantTx, contracts } from "@kimiterrace/db";
import { type InferSelectModel, and, desc, eq } from "drizzle-orm";

/**
 * F10 (#46): 広告主との契約 (CRM) の読み取り層。**サーバー専用**。
 *
 * contracts は **cross-tenant・system_admin 専用** (RLS `system_admin_full_access`、ADR-018/019)。
 * 呼び出し側は `requireRole(SYSTEM_ADMIN_ROLES)` + `withSession` (system_admin context) で RLS を
 * 満たすこと。本層の `WHERE advertiser_id = ...` / `WHERE id = ...` は**対象特定であってテナント境界
 * ではない** — 可視範囲は RLS が決め、非 system_admin context では 0 行に倒れる (ルール2)。
 *
 * **クエリの置き場所**: advertisers-queries / communications-queries と同様に `apps/web` へ inline する
 * (`packages/db` barrel を触る並行レーンとの衝突回避)。型は contracts スキーマ由来 (`InferSelectModel`)
 * のままなので単一ソースは維持する (ルール3)。
 *
 * 消費する UI (広告主詳細の契約一覧・編集フォーム初期値) は別スライス。本 PR は read 層 + 単体テストのみ。
 */

/** 一覧 1 行の軽量射影。配信対象校 (target_schools) と備考 (notes) は詳細ビューに回す。 */
export type ContractSummary = Pick<
  InferSelectModel<typeof contracts>,
  "id" | "status" | "startedAt" | "endedAt" | "monthlyFeeJpy" | "createdAt"
>;

/** ページング既定 / 上限。長い契約履歴で全件返しを避ける。 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** offset を非負整数へ。未指定 / 非有限 (NaN/Infinity) は 0 (clampLimit と対称、`.offset(NaN)` を防ぐ)。 */
function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * ある広告主の契約を新しい順に返す。並びは開始日降順、同開始日は記録時刻降順
 * (`ix_contracts_started_at` を利用)。`advertiserId` での絞り込みは対象特定であってテナント境界では
 * ない (上記 doc 参照)。`limit` は 1..500 にクランプ、`offset` は非負へ正規化。
 */
export async function listContractsByAdvertiser(
  tx: TenantTx,
  advertiserId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ContractSummary[]> {
  const limit = clampLimit(opts.limit);
  const offset = normalizeOffset(opts.offset);
  return await tx
    .select({
      id: contracts.id,
      status: contracts.status,
      startedAt: contracts.startedAt,
      endedAt: contracts.endedAt,
      monthlyFeeJpy: contracts.monthlyFeeJpy,
      createdAt: contracts.createdAt,
    })
    .from(contracts)
    .where(eq(contracts.advertiserId, advertiserId))
    .orderBy(desc(contracts.startedAt), desc(contracts.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * 編集フォームの初期値に使う詳細射影 (id + 編集可能フィールド + 親広告主 id)。一覧の軽量射影と違い
 * 配信対象校・備考も含む。
 */
export type ContractDetail = Pick<
  InferSelectModel<typeof contracts>,
  | "id"
  | "advertiserId"
  | "status"
  | "startedAt"
  | "endedAt"
  | "monthlyFeeJpy"
  | "targetSchools"
  | "notes"
>;

/**
 * 単一契約を id で取得する。`advertiserId` も渡された場合は **親広告主との一致を AND 条件に加える**
 * (URL 越しの id 取り違え / 別広告主の契約の誤表示を防ぐ防御。テナント境界ではなく整合チェック)。
 * 見つからなければ `null` (RLS 不可視 / 不存在は区別せず 404 相当、ルール2)。
 */
export async function getContractDetail(
  tx: TenantTx,
  id: string,
  advertiserId?: string,
): Promise<ContractDetail | null> {
  const condition =
    advertiserId === undefined
      ? eq(contracts.id, id)
      : and(eq(contracts.id, id), eq(contracts.advertiserId, advertiserId));
  const [row] = await tx
    .select({
      id: contracts.id,
      advertiserId: contracts.advertiserId,
      status: contracts.status,
      startedAt: contracts.startedAt,
      endedAt: contracts.endedAt,
      monthlyFeeJpy: contracts.monthlyFeeJpy,
      targetSchools: contracts.targetSchools,
      notes: contracts.notes,
    })
    .from(contracts)
    .where(condition)
    .limit(1);
  return row ?? null;
}
