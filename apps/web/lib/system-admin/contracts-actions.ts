"use server";

import { type TenantTx, auditLog, contracts } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { type ContractCreateInput, validateContractCreate } from "./contracts-core";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, invalid, notFound } from "./schools-core";

/** PostgreSQL foreign_key_violation (advertiser_id → advertisers)。存在しない広告主を弾く。 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503"
  );
}

/**
 * F10 (#46): 広告主との契約 (CRM) を新規作成する Server Action (ADR-008 — 画面 mutation は Server Actions)。
 *
 * **認可 (system_admin 限定)**: `requireRole(SYSTEM_ADMIN_ROLES)` で school_admin / teacher を 403。
 * 契約は cross-tenant の横断データで system_admin 専用 (ADR-018/019、advertisers と同区分)。
 *
 * **RLS (ルール2)**: contracts は `system_admin_full_access` policy で、INSERT は WITH CHECK
 * (`current_user_role='system_admin'`) のときのみ通る。`withSession` は system_admin context を張るので
 * 本アクションは成立する。`getDb()` は非 BYPASSRLS の `kimiterrace_app` 接続。手書き WHERE は無く、
 * テナント境界は RLS が決める。
 *
 * **存在しない広告主**: `advertiser_id` は `restrict` FK。存在しない id を渡すと INSERT が
 * foreign_key_violation (23503) になるため `not_found` に倒す (検証段階では UUID 形式のみ確認し、
 * 実在は DB の参照整合性に委ねる)。
 *
 * **監査 (ルール1)**: 作成を同一 tx で audit_log に追記する。契約は紐づく学校が無いため `school_id=NULL`、
 * system_admin は users 行でないため `actor_user_id` / `created_by` / `updated_by` も NULL とする
 * (0005 policy が system_admin context の NULL school_id / NULL actor を許可)。
 */
export async function createContractAction(raw: {
  advertiserId?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  monthlyFeeJpy?: unknown;
  targetSchools?: unknown;
  notes?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateContractCreate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  // 認可: system_admin のみ。redirect 副作用 (未認証→/login, 権限不足→/forbidden) はここで起きる。
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      const [row] = await tx
        .insert(contracts)
        .values({
          advertiserId: v.value.advertiserId,
          status: v.value.status,
          startedAt: v.value.startedAt,
          endedAt: v.value.endedAt,
          monthlyFeeJpy: v.value.monthlyFeeJpy,
          targetSchools: v.value.targetSchools,
          notes: v.value.notes,
          // system_admin は users 行ではないため監査カラムの actor は NULL (FK は users(id))。
          createdBy: isSystemAdmin ? null : user.uid,
          updatedBy: isSystemAdmin ? null : user.uid,
        })
        .returning({ id: contracts.id });
      if (!row) {
        // 多層防御: INSERT が 0 行 = RLS WITH CHECK 不成立 (本来 403 で来ない)。
        throw new Error("contract insert returned no row");
      }
      await writeContractAudit(tx, user, row.id, v.value);
      return { id: row.id };
    });
    revalidatePath(`/admin/system/advertisers/${v.value.advertiserId}/edit`);
    return { ok: true, data };
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return notFound("指定された広告主が見つかりません。");
    }
    throw error;
  }
}

/**
 * audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。
 * 契約は cross-tenant なので `school_id=NULL`、system_admin は actor 系も NULL。
 * 日付は jsonb diff 内で ISO 文字列に明示変換する (Date のまま入れない、表現を安定させる)。
 */
async function writeContractAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  contractId: string,
  input: ContractCreateInput,
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId: null,
    tableName: "contracts",
    recordId: contractId,
    operation: "insert",
    diff: {
      after: {
        advertiserId: input.advertiserId,
        status: input.status,
        startedAt: input.startedAt.toISOString(),
        endedAt: input.endedAt ? input.endedAt.toISOString() : null,
        monthlyFeeJpy: input.monthlyFeeJpy,
        targetSchools: input.targetSchools,
        notes: input.notes,
      },
    },
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}
