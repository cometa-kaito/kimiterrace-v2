"use server";

import { type TenantTx, advertisers, auditLog } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { type AdvertiserCreateInput, validateAdvertiserCreate } from "./advertisers-core";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, invalid } from "./schools-core";

/**
 * F10 (#46): 広告主 (CRM) を新規作成する Server Action (ADR-008 — 画面 mutation は Server Actions)。
 *
 * **認可 (system_admin 限定)**: `requireRole(SYSTEM_ADMIN_ROLES)` で school_admin / teacher を 403。
 * 広告主マスタは cross-tenant の横断データで system_admin 専用 (ADR-018/019)。
 *
 * **RLS (ルール2)**: advertisers は `system_admin_full_access` policy で、INSERT は WITH CHECK
 * (`current_user_role='system_admin'`) のときのみ通る。`withSession` は system_admin context を張るので
 * 本アクションは成立する。`getDb()` は非 BYPASSRLS の `kimiterrace_app` 接続。
 *
 * **監査 (ルール1)**: 作成を同一 tx で audit_log に追記する。advertisers は紐づく学校が無いため
 * `school_id=NULL`、system_admin は users 行でないため `actor_user_id` / `created_by` / `updated_by` も
 * NULL とする (0005 policy が system_admin context の NULL school_id / NULL actor を許可)。advertisers に
 * unique 制約は無いので 23505 (conflict) 経路は不要。
 */
export async function createAdvertiserAction(raw: {
  companyName?: unknown;
  industry?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
  address?: unknown;
  notes?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateAdvertiserCreate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  // 認可: system_admin のみ。redirect 副作用 (未認証→/login, 権限不足→/forbidden) はここで起きる。
  await requireRole(SYSTEM_ADMIN_ROLES);

  const data = await withSession(async (tx: TenantTx, user) => {
    const isSystemAdmin = user.role === "system_admin";
    const [row] = await tx
      .insert(advertisers)
      .values({
        companyName: v.value.companyName,
        industry: v.value.industry,
        contactEmail: v.value.contactEmail,
        contactPhone: v.value.contactPhone,
        address: v.value.address,
        notes: v.value.notes,
        // system_admin は users 行ではないため監査カラムの actor は NULL (FK は users(id))。
        createdBy: isSystemAdmin ? null : user.uid,
        updatedBy: isSystemAdmin ? null : user.uid,
      })
      .returning({ id: advertisers.id });
    if (!row) {
      // 多層防御: INSERT が 0 行 = RLS WITH CHECK 不成立 (本来 403 で来ない)。
      throw new Error("advertiser insert returned no row");
    }
    await writeAdvertiserAudit(tx, user, row.id, v.value);
    return { id: row.id };
  });
  revalidatePath("/admin/system/advertisers");
  return { ok: true, data };
}

/**
 * audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。
 * advertisers は cross-tenant なので `school_id=NULL`、system_admin は actor 系も NULL。
 */
async function writeAdvertiserAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  advertiserId: string,
  input: AdvertiserCreateInput,
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId: null,
    tableName: "advertisers",
    recordId: advertiserId,
    operation: "insert",
    diff: { after: input },
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}
