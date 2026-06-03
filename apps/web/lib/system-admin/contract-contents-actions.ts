"use server";

import { type TenantTx, auditLog, contractContents } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, conflict, invalid, isUuid, notFound } from "./schools-core";

/**
 * F10 (#46): 契約 ⇄ 出稿コンテンツの紐付け (link) / 解除 (unlink) を行う Server Action
 * (ADR-008 — 画面 mutation は Server Actions)。
 *
 * **認可 (system_admin 限定)**: `requireRole(SYSTEM_ADMIN_ROLES)` で school_admin / teacher を 403。
 * contract_contents は cross-tenant CRM 中間表で system_admin 専用 (ADR-018/019、contracts と同区分)。
 *
 * **RLS (ルール2)**: contract_contents は `system_admin_full_access` policy のみ (migration 0020)。
 * INSERT / DELETE は WITH CHECK / USING (`current_user_role='system_admin'`) のときだけ通る。
 * `withSession` が system_admin context を張るので本アクションは成立する。`getDb()` は非 BYPASSRLS の
 * `kimiterrace_app` 接続で、手書き WHERE は対象特定であってテナント境界ではない。
 *
 * **監査 (ルール1 / NFR04)**: link/unlink を同一 tx で audit_log に追記する。中間表は紐づく学校が無いため
 * `school_id=NULL`、system_admin は users 行でないため `actor_user_id` / `created_by` / `updated_by` も
 * NULL とする (0005 policy が system_admin context の NULL school_id / NULL actor を許可)。
 */

/** PostgreSQL unique_violation (UNIQUE(contract_id, content_id))。二重紐付けを弾く。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

/** PostgreSQL foreign_key_violation (contract_id / content_id の不存在)。存在しない参照を弾く。 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503"
  );
}

/** 対象の紐付けが見つからない (RLS 不可視 / 不存在) とき tx をロールバックさせる。 */
class LinkNotFoundError extends Error {}

/**
 * 出稿コンテンツを契約に紐付ける。`contractId` × `contentId` を contract_contents に 1 行 INSERT する。
 *
 * - 入力検証: 両 id が UUID 形式であること (実在は DB の参照整合性 = FK に委ねる)。
 * - 重複 (既に紐付け済み): UNIQUE 制約違反 (23505) を `conflict` に倒す。
 * - 不存在の契約 / コンテンツ: FK 違反 (23503) を `not_found` に倒す
 *   (system_admin から不可視のコンテンツ = RLS で WITH CHECK が成立しないため `not_found` 相当だが、
 *    contents は system_admin に cross-tenant 可視なので実質「存在しない id」を意味する)。
 *
 * `advertiserId` は紐付けに不要だが、成功後の revalidate 先 (広告主の契約ページ) を特定するため受け取る。
 */
export async function linkContentToContractAction(raw: {
  contractId?: unknown;
  contentId?: unknown;
  advertiserId?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(raw.contractId)) {
    return invalid("契約の指定が不正です。");
  }
  if (!isUuid(raw.contentId)) {
    return invalid("コンテンツの指定が不正です。");
  }
  const contractId = raw.contractId;
  const contentId = raw.contentId;
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      const [row] = await tx
        .insert(contractContents)
        .values({
          contractId,
          contentId,
          // system_admin は users 行ではないため監査カラムの actor は NULL (FK は users(id))。
          createdBy: isSystemAdmin ? null : user.uid,
          updatedBy: isSystemAdmin ? null : user.uid,
        })
        .returning({ id: contractContents.id });
      if (!row) {
        // 多層防御: INSERT が 0 行 = RLS WITH CHECK 不成立 (本来 403 で来ない)。
        throw new Error("contract_contents insert returned no row");
      }
      await writeLinkAudit(tx, user, "insert", row.id, { contractId, contentId });
      return { id: row.id };
    });
    if (isUuid(raw.advertiserId)) {
      revalidatePath(`/admin/system/advertisers/${raw.advertiserId}/contracts`);
    }
    return { ok: true, data };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return conflict("このコンテンツは既にこの契約に紐付いています。");
    }
    if (isForeignKeyViolation(error)) {
      return notFound("指定された契約またはコンテンツが見つかりません。");
    }
    throw error;
  }
}

/**
 * 出稿コンテンツの紐付けを解除する。`linkId` (contract_contents.id) の行を 1 行 DELETE する。
 *
 * - 入力検証: `linkId` が UUID 形式であること。
 * - 対象が無い (RLS 不可視 / 既に解除済み / 不存在): DELETE が 0 行で `not_found`。
 *
 * `advertiserId` は revalidate 先 (広告主の契約ページ) の特定にのみ使う。
 */
export async function unlinkContentFromContractAction(raw: {
  linkId?: unknown;
  advertiserId?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(raw.linkId)) {
    return invalid("紐付けの指定が不正です。");
  }
  const linkId = raw.linkId;
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      // 監査 diff 用に解除前の (contract_id, content_id) を同一 tx で取得 (兼 not_found 検出)。
      const [before] = await tx
        .select({
          contractId: contractContents.contractId,
          contentId: contractContents.contentId,
        })
        .from(contractContents)
        .where(eq(contractContents.id, linkId))
        .limit(1);
      if (!before) {
        throw new LinkNotFoundError();
      }
      const deleted = await tx
        .delete(contractContents)
        .where(eq(contractContents.id, linkId))
        .returning({ id: contractContents.id });
      if (deleted.length === 0) {
        // 多層防御: SELECT が通って DELETE が 0 行 = RLS 越境 (本来到達しない)。
        throw new LinkNotFoundError();
      }
      await writeLinkAudit(tx, user, "delete", linkId, before);
      return { id: linkId };
    });
    if (isUuid(raw.advertiserId)) {
      revalidatePath(`/admin/system/advertisers/${raw.advertiserId}/contracts`);
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof LinkNotFoundError) {
      return notFound("指定された紐付けが見つかりません。");
    }
    throw error;
  }
}

/**
 * 紐付けの link/unlink を audit_log に追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT
 * トリガが計算。中間表は cross-tenant なので `school_id=NULL`、system_admin は actor 系も NULL。
 * insert は `after` のみ、delete は `before` のみを diff に持つ (audit-log schema docstring 準拠)。
 */
async function writeLinkAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  operation: "insert" | "delete",
  linkId: string,
  pair: { contractId: string; contentId: string },
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId: null,
    tableName: "contract_contents",
    recordId: linkId,
    operation,
    diff: operation === "insert" ? { after: pair } : { before: pair },
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}
