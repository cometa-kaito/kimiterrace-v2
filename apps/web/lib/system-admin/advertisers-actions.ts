"use server";

import { type TenantTx, advertisers, auditLog } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { type AdvertiserCreateInput, validateAdvertiserCreate } from "./advertisers-core";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, invalid, isUuid, notFound } from "./schools-core";

/** 対象広告主が見つからない (RLS 不可視 / 不存在) とき tx をロールバックさせる。 */
class AdvertiserNotFoundError extends Error {}

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

/**
 * F10 (#46): 広告主の稼働状態 (`is_active`) を切り替える Server Action。停止 = 論理削除
 * (advertisers schema: 過去契約のトレースを残すため物理 DELETE しない)、再開でその逆。
 *
 * 認可は `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin 限定)。UPDATE は advertisers の
 * `system_admin_full_access` policy で通る (ルール2)。対象が RLS で不可視 / 不存在なら UPDATE が 0 行と
 * なり `not_found` に倒す (手書き WHERE は対象特定であってテナント境界ではない)。状態変更を同一 tx で
 * audit_log に記録する (ルール1、advertisers は cross-tenant なので school_id / actor は NULL)。
 */
export async function setAdvertiserActiveAction(raw: {
  id?: unknown;
  isActive?: unknown;
}): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  if (!isUuid(raw.id)) {
    return invalid("広告主の指定が不正です。");
  }
  if (typeof raw.isActive !== "boolean") {
    return invalid("状態の指定が不正です。");
  }
  const id = raw.id;
  const isActive = raw.isActive;
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const isSystemAdmin = user.role === "system_admin";
      const updated = await tx
        .update(advertisers)
        // updated_at は auditColumns では INSERT 時のみ default のため UPDATE では明示更新する
        // (sibling の schools/magic-links/contents の UPDATE と同方針、ルール1: 監査カラム整合)。
        .set({ isActive, updatedBy: isSystemAdmin ? null : user.uid, updatedAt: new Date() })
        .where(eq(advertisers.id, id))
        .returning({ id: advertisers.id });
      if (updated.length === 0) {
        throw new AdvertiserNotFoundError();
      }
      await writeAdvertiserActiveAudit(tx, user, id, isActive);
      return { id, isActive };
    });
    revalidatePath("/admin/system/advertisers");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof AdvertiserNotFoundError) {
      return notFound("指定された広告主が見つかりません。");
    }
    throw error;
  }
}

/** 稼働状態変更を audit_log に追記 (operation=update、diff は変更後の is_active のみ)。 */
async function writeAdvertiserActiveAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  advertiserId: string,
  isActive: boolean,
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId: null,
    tableName: "advertisers",
    recordId: advertiserId,
    operation: "update",
    diff: { after: { isActive } },
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}
