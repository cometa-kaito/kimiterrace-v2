import { type TenantTx, contents, contractContents } from "@kimiterrace/db";
import { desc, eq } from "drizzle-orm";

/**
 * F10 (#46): 契約 ⇄ 出稿コンテンツ紐付けの読み取り層。**サーバー専用**。
 *
 * contract_contents は **cross-tenant・system_admin 専用**（RLS `system_admin_full_access`、ADR-018/019、
 * migration 0020）。呼び出し側は `requireRole(SYSTEM_ADMIN_ROLES)` + `withSession`（system_admin context）
 * で RLS を満たすこと。本層の `WHERE contract_id = ...` は**対象特定であってテナント境界ではない** —
 * 可視範囲は RLS が決め、非 system_admin context では 0 行に倒れる（ルール2）。
 *
 * contents との結合タイトル取得は contents の RLS に委ねる。contents には migration 0002 で
 * `system_admin_full_access` policy があるため、system_admin context では cross-tenant に全 contents が
 * 可視で結合が成立する。非 system_admin は contract_contents 自体が 0 行なので結合結果も空（多層防御）。
 *
 * **クエリの置き場所**: contracts-queries / advertisers-queries と同様に `apps/web` へ inline する
 * （`packages/db` barrel を触る並行レーンとの衝突回避）。型は contract_contents / contents スキーマ由来
 * （列射影）のままなので単一ソースは維持する（ルール3）。
 */

/** 紐付け 1 行の射影。link 自体の id（unlink 用）+ コンテンツ id / タイトル / 所属校 + 紐付け日時。 */
export type LinkedContent = {
  /** contract_contents.id（unlink 操作の対象キー）。 */
  linkId: string;
  /** 紐付いた contents.id。 */
  contentId: string;
  /** 紐付いた contents.title（RLS 経由で取得）。 */
  title: string;
  /** 紐付いた contents.school_id（どの学校のコンテンツか表示用）。 */
  schoolId: string;
  /** 紐付けた日時（新しい順の並び替えキー）。 */
  linkedAt: Date;
};

/** ページング既定 / 上限。大量の紐付けで全件返しを避ける。 */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * ある契約に紐付いた出稿コンテンツを新しい順（紐付け日時 = created_at 降順）に返す。
 * contents との INNER JOIN でタイトル / 所属校を取得する。`contractId` での絞り込みは対象特定であって
 * テナント境界ではない（上記 doc 参照）。`limit` は 1..1000 にクランプ、`offset` は非負へ正規化。
 */
export async function listLinkedContents(
  tx: TenantTx,
  contractId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<LinkedContent[]> {
  const limit = clampLimit(opts.limit);
  const offset = normalizeOffset(opts.offset);
  return await tx
    .select({
      linkId: contractContents.id,
      contentId: contents.id,
      title: contents.title,
      schoolId: contents.schoolId,
      linkedAt: contractContents.createdAt,
    })
    .from(contractContents)
    .innerJoin(contents, eq(contractContents.contentId, contents.id))
    .where(eq(contractContents.contractId, contractId))
    .orderBy(desc(contractContents.createdAt))
    .limit(limit)
    .offset(offset);
}
