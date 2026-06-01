"use server";

import { type TenantTx, auditLog, users } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { deactivateIdpUser, reactivateIdpUser } from "../auth/admin-mutations";
import { requireRole } from "../auth/guard";
import type { AuthUser } from "../auth/session";
import { withSession } from "../db";
import {
  type ActionResult,
  forbidden,
  invalid,
  isUuid,
  notFound,
} from "../system-admin/schools-core";
import { type RoleActor, canDisableAccount } from "./policy";
import { MEMBER_ADMIN_ROLES } from "./roles";

/**
 * F11 (#47 / #324, ADR-026): 自校教職員のアカウント **無効化 / 再有効化** Server Action。
 *
 * #318 の教職員一覧 (read + 管理可否表示) に対する **操作系の第1スライス**。ADR-026 が確定した
 * 「**Identity Platform を認証エンフォースの単一ソースとし、DB の `users` は mirror とする**」方針を
 * 実装する。DB-only の状態変更を「無効化」と称さない (ADR-026 D3) — IdP の disable + refresh token
 * 失効 (`deactivateIdpUser`) を必ず一体で行い、`is_active` フラグだけ立てる security theater を作らない。
 *
 * ## 実行順 (ADR-026: IdP を先に、DB mirror を後に)
 * 1. 入力検証 → `requireRole(MEMBER_ADMIN_ROLES)` (school_admin 限定。teacher / system_admin は
 *    `/forbidden` に redirect)。
 * 2. **self-guard**: 自分自身を対象にできない (ロックアウト防止、ADR-026 実装ノート)。
 * 3. RLS tx で対象の現ロール / 状態を読み (自校外は 0 行 = `not_found`)、`canDisableAccount` で role 境界を
 *    強制する。RLS は school 境界しか守らない ([[rls-tenant-not-role-boundary]]) ため、「school_admin は
 *    自校 teacher のみ操作可」は policy + handler が強制する (ルール2 多層防御)。read tx は短く閉じ、
 *    外部 IdP 呼び出しを **跨がない** (DB 接続/ロックを外部往復中に保持しない)。
 * 4. **IdP 更新を先に**実行 — 失効はここで確定する (エンフォースの単一ソース)。
 * 5. 成功後に DB `users.is_active` を mirror 更新 + `audit_log` を同一 tx で記録する (ルール1)。
 *
 * IdP が失敗すれば DB は触らず**安全側** (旧状態を維持)。IdP 成功後に DB mirror が失敗しても、
 * エンフォースは IdP が真実なので**安全側に倒れる** (表示の遅延のみ、ADR-026 トレードオフ)。
 *
 * ## last-admin ガードについて (本スライスでの扱い)
 * 本スライスの対象は **teacher のみ** (policy が school_admin の操作対象を自校 teacher に限定)。ADR-026 が
 * 求める「最後の有効な system_admin / school_admin の無効化・降格の拒否」は、対象が admin になりうる
 * **system_admin 管理面 / ロール降格 (D2)** スライスで導入する。teacher の無効化では admin ロックアウトは
 * 構造的に発生しないため、本スライスでは self-guard のみを明示する (honest scoping)。
 */
export async function setMemberActiveAction(raw: {
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

  // 認可: school_admin のみ。未認証→/login, 権限不足→/forbidden の redirect 副作用はここで起きる。
  const actor = await requireRole(MEMBER_ADMIN_ROLES);

  // self-guard (ロックアウト防止、ADR-026): 自分自身の状態は変更できない。policy も school_admin の
  // 自分行 (= school_admin role) を `target_not_teacher` で弾くが、ここで明示し理由を分かりやすく返す。
  if (userId === actor.uid) {
    return forbidden("自分自身のアカウント状態は変更できません。");
  }

  // 1) RLS tx: 対象の現ロール / 状態を読み、role 境界を強制する (IdP 呼び出しを跨がない短い read)。
  const gate = await withSession(
    async (tx, user) => {
      const [row] = await tx
        .select({ role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!row) {
        return { kind: "not_found" as const };
      }
      const roleActor: RoleActor = { role: user.role, schoolId: user.schoolId };
      const decision = canDisableAccount(roleActor, {
        targetCurrentRole: row.role,
        // RLS で自校に絞られているため対象校 = 自校 (user.schoolId)。手書き WHERE ではなく RLS が境界。
        targetSchoolId: user.schoolId,
      });
      if (!decision.allowed) {
        return { kind: "forbidden" as const };
      }
      return { kind: "ok" as const, before: row.isActive };
    },
    { allowedRoles: MEMBER_ADMIN_ROLES },
  );

  if (gate.kind === "not_found") {
    return notFound("指定されたユーザーが見つかりません。");
  }
  if (gate.kind === "forbidden") {
    return forbidden("このユーザーのアカウント状態を変更する権限がありません。");
  }

  // 2) IdP 更新を先に (ADR-026)。失効はここで確定する。
  if (nextActive) {
    await reactivateIdpUser(userId);
  } else {
    await deactivateIdpUser(userId);
  }

  // 3) DB mirror + 監査を同一 tx で。自校テナント操作なので audit の school_id / actor は user のもの。
  await withSession(
    async (tx, user) => {
      const updated = await tx
        .update(users)
        // updated_at は auditColumns では INSERT 時のみ default のため UPDATE では明示更新する
        // (sibling UPDATE と同方針、ルール1: 監査カラム整合、[[updatedat-explicit-on-update]])。
        .set({ isActive: nextActive, updatedBy: user.uid, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (updated.length === 0) {
        // 多層防御: read が通って UPDATE が 0 行 = RLS 越境 (本来到達しない)。IdP は既に更新済 (安全側)。
        throw new Error("user is_active mirror update affected no row");
      }
      await writeMemberActiveAudit(tx, user, userId, gate.before, nextActive);
    },
    { allowedRoles: MEMBER_ADMIN_ROLES },
  );

  revalidatePath("/admin/school/members");
  return { ok: true, data: { id: userId, isActive: nextActive } };
}

/**
 * アカウント状態変更を `audit_log` に追記する (ルール1 / NFR04)。prev_hash / row_hash は BEFORE INSERT
 * トリガが計算。自校テナント操作なので `school_id` = actor の自校、actor 系は school_admin の users 行。
 * diff は変更前後の `is_active` (不可逆ではないが認証エンフォースに直結するため前後を残す)。
 */
async function writeMemberActiveAudit(
  tx: TenantTx,
  user: AuthUser,
  userId: string,
  before: boolean,
  after: boolean,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: user.uid,
    schoolId: user.schoolId,
    tableName: "users",
    recordId: userId,
    operation: "update",
    diff: { before: { isActive: before }, after: { isActive: after } },
    rowHash: "",
    createdBy: user.uid,
    updatedBy: user.uid,
  });
}
