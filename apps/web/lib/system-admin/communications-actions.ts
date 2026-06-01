"use server";

import { type TenantTx, auditLog, communications } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { type CommunicationCreateInput, validateCommunicationCreate } from "./communications-core";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, invalid, notFound } from "./schools-core";

/**
 * PostgreSQL foreign_key_violation。communications は advertiser_id (cascade) と contract_id
 * (set null) の 2 つの FK を持ち、どちらの親が不在でも INSERT 時に 23503 になる。
 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503"
  );
}

/**
 * F10 (#46): 広告主とのコミュニケーション履歴 (CRM) を 1 件記録する Server Action
 * (ADR-008 — 画面 mutation は Server Actions)。
 *
 * **認可 (system_admin 限定)**: `requireRole(SYSTEM_ADMIN_ROLES)` で school_admin / teacher を 403。
 * コミュニケーションは cross-tenant の営業データで system_admin 専用 (ADR-018/019、contracts と同区分)。
 *
 * **RLS (ルール2)**: communications は `system_admin_full_access` policy で、INSERT は WITH CHECK
 * (`current_user_role='system_admin'`) のときのみ通る。`withSession` は system_admin context を張る。
 * `getDb()` は非 BYPASSRLS の `kimiterrace_app` 接続。手書き WHERE は無く、テナント境界は RLS が決める。
 *
 * **存在しない広告主 / 契約**: 検証段階では UUID 形式のみ確認し、実在は DB の参照整合性 (FK) に委ねる。
 * 不在の id を渡すと foreign_key_violation (23503) になるため `not_found` に倒す。
 *
 * **監査 (ルール1)**: 作成を同一 tx で audit_log に追記する。cross-tenant のため `school_id=NULL`、
 * system_admin は users 行でないため `actor_user_id` / `created_by` / `updated_by` も NULL とする。
 */
export async function createCommunicationAction(raw: {
  advertiserId?: unknown;
  contractId?: unknown;
  channel?: unknown;
  occurredAt?: unknown;
  subject?: unknown;
  bodyMd?: unknown;
  attachments?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateCommunicationCreate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  // 認可: system_admin のみ。redirect 副作用 (未認証→/login, 権限不足→/forbidden) はここで起きる。
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      const [row] = await tx
        .insert(communications)
        .values({
          advertiserId: v.value.advertiserId,
          contractId: v.value.contractId,
          channel: v.value.channel,
          occurredAt: v.value.occurredAt,
          subject: v.value.subject,
          bodyMd: v.value.bodyMd,
          attachmentsJson: v.value.attachments,
          // system_admin は users 行ではないため監査カラムの actor は NULL (FK は users(id))。
          createdBy: isSystemAdmin ? null : user.uid,
          updatedBy: isSystemAdmin ? null : user.uid,
        })
        .returning({ id: communications.id });
      if (!row) {
        // 多層防御: INSERT が 0 行 = RLS WITH CHECK 不成立 (本来 403 で来ない)。
        throw new Error("communication insert returned no row");
      }
      await writeCommunicationAudit(tx, user, row.id, v.value);
      return { id: row.id };
    });
    revalidatePath(`/admin/system/advertisers/${v.value.advertiserId}/edit`);
    return { ok: true, data };
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return notFound("指定された広告主または契約が見つかりません。");
    }
    throw error;
  }
}

/**
 * audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。
 * cross-tenant なので `school_id=NULL`、system_admin は actor 系も NULL。
 * occurred_at は jsonb diff 内で ISO 文字列に明示変換する (Date のまま入れない、表現を安定させる)。
 */
async function writeCommunicationAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  communicationId: string,
  input: CommunicationCreateInput,
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId: null,
    tableName: "communications",
    recordId: communicationId,
    operation: "insert",
    diff: {
      after: {
        advertiserId: input.advertiserId,
        contractId: input.contractId,
        channel: input.channel,
        occurredAt: input.occurredAt.toISOString(),
        subject: input.subject,
        bodyMd: input.bodyMd,
        attachments: input.attachments,
      },
    },
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}
