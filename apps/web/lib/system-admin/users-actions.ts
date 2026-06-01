"use server";

import { type TenantTx, auditLog, users } from "@kimiterrace/db";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { deactivateIdpUser, reactivateIdpUser } from "../auth/admin-mutations";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, conflict, forbidden, invalid, isUuid, notFound } from "./schools-core";

/**
 * F11 (#47 / #324, ADR-026): system_admin が **全校横断**で教職員のアカウントを無効化 / 再有効化する
 * Server Action。`/admin/system/users` (#343) の各行から呼ぶ。
 *
 * #336 の自校版 (`setMemberActiveAction`、school_admin → 自校 teacher) に対する **system_admin 版**で、
 * 任意校の school_admin / teacher を対象にできる。エンフォースは #336 と同じ IdP seam
 * (`deactivateIdpUser` = disable + `revokeRefreshTokens` / `reactivateIdpUser` = enable) を再利用する
 * (ADR-026: IdP が認証エンフォースの単一ソース、DB の `is_active` は mirror)。
 *
 * ## 実行順 (ADR-026: IdP を先に、DB mirror を後に)
 * 1. 入力検証 → `requireRole(SYSTEM_ADMIN_ROLES)` (school_admin / teacher は 403)。
 * 2. RLS tx (system_admin context) で対象の現ロール / 状態 / 所属校を読む (`system_admin_full_access`
 *    で全校可視。自校外でも読める)。教職員以外 (student/guardian、IdP アカウント無し) は対象外。
 * 3. **last-admin ガード (ADR-026 / ロックアウト防止)**: 対象が **その学校で最後の有効な school_admin**
 *    なら無効化を拒否する (学校が管理者ゼロになるのを防ぐ)。
 * 4. **IdP 更新を先に** (失効を確定)。
 * 5. 成功後に DB `users.is_active` mirror 更新 + `audit_log` を同一 tx で記録 (ルール1)。
 *
 * ## 監査 (ルール1 / NFR04)
 * `users` はテナントスコープなので `audit_log.school_id` は **対象の所属校** を記録する (audit_log_insert
 * policy は system_admin context で任意 school_id を許可)。actor は **system_admin は `users` 行でない**ため
 * `actor_user_id` / `created_by` / `updated_by` を NULL とする (advertisers と同じ cross-tenant actor 規律、
 * system_admin の同定はアプリ/IdP セッションログ側)。
 */
export async function setStaffActiveAction(raw: {
  userId?: unknown;
  isActive?: unknown;
}): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  if (!isUuid(raw.userId)) {
    return invalid("ユーザーの指定が不正です。");
  }
  if (typeof raw.isActive !== "boolean") {
    return invalid("状態の指定が不正です。");
  }
  const userId = raw.userId;
  const nextActive = raw.isActive;

  await requireRole(SYSTEM_ADMIN_ROLES);

  // 1) RLS tx: 対象の現ロール / 状態 / 所属校を読み、教職員限定 + last-admin ガードを評価する
  //    (IdP 呼び出しを跨がない短い read)。
  const gate = await withGate(userId, nextActive);

  if (gate.kind === "not_found") {
    return notFound("指定されたユーザーが見つかりません。");
  }
  if (gate.kind === "not_staff") {
    // 一覧は教職員のみを出すため通常到達しない。生徒/保護者は IdP アカウントを持たない (対象外)。
    return forbidden("教職員以外のアカウントはこの画面では操作できません。");
  }
  if (gate.kind === "last_admin") {
    return conflict(
      "この学校で唯一の有効な学校管理者のため無効化できません。先に別の学校管理者を有効化してください。",
    );
  }

  // 2) IdP 更新を先に (ADR-026)。失効はここで確定する。
  if (nextActive) {
    await reactivateIdpUser(userId);
  } else {
    await deactivateIdpUser(userId);
  }

  // 3) DB mirror + 監査を同一 tx で。テナント監査なので school_id は対象校、actor は system_admin ゆえ NULL。
  await withSession(
    async (tx) => {
      const updated = await tx
        .update(users)
        // updated_at は auditColumns では INSERT 時のみ default のため UPDATE では明示更新する (ルール1)。
        .set({ isActive: nextActive, updatedBy: null, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (updated.length === 0) {
        // 多層防御: read が通って UPDATE 0 行 = RLS 越境 (本来到達しない)。IdP は既に更新済 (安全側)。
        throw new Error("user is_active mirror update affected no row");
      }
      await tx.insert(auditLog).values({
        actorUserId: null,
        schoolId: gate.schoolId,
        tableName: "users",
        recordId: userId,
        operation: "update",
        diff: { before: { isActive: gate.before }, after: { isActive: nextActive } },
        rowHash: "",
        createdBy: null,
        updatedBy: null,
      });
    },
    { allowedRoles: SYSTEM_ADMIN_ROLES },
  );

  revalidatePath("/admin/system/users");
  return { ok: true, data: { id: userId, isActive: nextActive } };
}

type GateResult =
  | { kind: "not_found" }
  | { kind: "not_staff" }
  | { kind: "last_admin" }
  | { kind: "ok"; schoolId: string; before: boolean };

/**
 * 対象ユーザーの現状態を読み、教職員限定 + last-admin ガードを評価して判定を返す。read のみの短い tx。
 */
async function withGate(userId: string, nextActive: boolean): Promise<GateResult> {
  return await withSession(
    async (tx: TenantTx) => {
      const [row] = await tx
        .select({ role: users.role, isActive: users.isActive, schoolId: users.schoolId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!row) {
        return { kind: "not_found" } as const;
      }
      if (row.role !== "school_admin" && row.role !== "teacher") {
        return { kind: "not_staff" } as const;
      }
      // last-admin ガード: 有効な school_admin を無効化しようとしていて、その人が学校で唯一の有効な
      // 管理者なら拒否する (再有効化や teacher は対象外、既に無効なら lockout リスク無しで対象外)。
      if (!nextActive && row.role === "school_admin" && row.isActive) {
        const [c] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(
            and(
              eq(users.schoolId, row.schoolId),
              eq(users.role, "school_admin"),
              eq(users.isActive, true),
            ),
          );
        if ((c?.n ?? 0) <= 1) {
          return { kind: "last_admin" } as const;
        }
      }
      return { kind: "ok", schoolId: row.schoolId, before: row.isActive } as const;
    },
    { allowedRoles: SYSTEM_ADMIN_ROLES },
  );
}
