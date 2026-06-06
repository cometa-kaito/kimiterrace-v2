"use server";

import { randomUUID } from "node:crypto";
import { type TenantTx, auditLog, users } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  createIdpUser,
  deactivateIdpUser,
  deleteIdpUser,
  isEmailAlreadyExistsError,
  reactivateIdpUser,
} from "../auth/admin-mutations";
import { requireRole } from "../auth/guard";
import type { AuthUser } from "../auth/session";
import { withSession } from "../db";
import {
  type ActionResult,
  conflict,
  forbidden,
  invalid,
  isUuid,
  notFound,
} from "../system-admin/schools-core";
import { type RoleActor, canDisableAccount } from "./policy";
import { MEMBER_ADMIN_ROLES } from "./roles";
import { validateStaffCreate } from "./staff-create-core";

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

/**
 * F11 (#508): school_admin が **自校 teacher アカウントを新規発行**する Server Action (発行 MVP)。
 *
 * 認証は email+password (`app/login`)。本 action は IdP user を作成し、初回パスワード設定リンクを返す
 * (発行者が利用者へ共有、email infra 非依存)。ADR-003 の provisioning 規約・ADR-026 の IdP 単一ソース
 * に従う。
 *
 * ## 規律
 * - **role 境界 (ルール2 多層防御)**: school_admin は **teacher のみ** 発行可。role は入力で受けず `teacher`
 *   固定 (school_admin / system_admin の発行は system 管理面の別スライス)。RLS は school 境界しか守らない
 *   ([[rls-tenant-not-role-boundary]]) ため app 層で role を固定する。`requireRole(MEMBER_ADMIN_ROLES)` で
 *   teacher / system_admin の呼出は /forbidden。
 * - **uid 規約 (ADR-003)**: `randomUUID()` を生成し **createUser の localId・`users.id`・`identity_uid`
 *   の三者に共用**。これで localId == users.id となり、作成後のアカウントを既存の無効化/ロール変更 seam
 *   (users.id を IdP uid として渡す) で操作できる。
 * - **IdP を先に (ADR-026)**: IdP=エンフォース単一ソース。createUser→claims→reset link を先に確定し、
 *   その後 DB mirror + 監査を同一 tx で書く (ルール1)。
 * - **部分失敗の補償**: IdP 作成成功後に DB mirror が失敗したら、孤児 IdP user (DB 行が無く管理不能) を
 *   `deleteIdpUser` で補償削除して roll back する ([[feedback_last_admin_toctou_for_update_idp_compensation]] と
 *   同思想)。メール重複は createUser が `auth/email-already-exists` で弾くので conflict に整形する。
 * - **RLS INSERT**: `tenant_isolation ON users FOR ALL WITH CHECK(school_id=current)` が自校 INSERT を許可。
 *   school_id は actor の自校 (claims 由来) で WITH CHECK を満たす。0015 last-admin トリガは UPDATE/DELETE
 *   のみで INSERT 非対象。
 */
export async function createStaffAction(raw: {
  email?: unknown;
  displayName?: unknown;
}): Promise<ActionResult<{ id: string; setupLink: string }>> {
  // 入力検証 (IdP / DB 到達前に弾く)。規則・メッセージは staff-create-core が単一ソース
  // (client フォームの項目別検証 collectStaffCreateFieldErrors と同一)。
  const validated = validateStaffCreate(raw);
  if (!validated.ok) {
    return invalid(validated.message);
  }
  const { email, displayName } = validated.value;

  // 認可: school_admin のみ。未認証→/login, 権限不足→/forbidden の redirect 副作用はここで起きる。
  const actor = await requireRole(MEMBER_ADMIN_ROLES);
  if (!actor.schoolId) {
    // MEMBER_ADMIN_ROLES = school_admin なので通常 schoolId は非 null。型安全 + 防御で弾く。
    return forbidden("所属校が特定できないため発行できません。");
  }
  const schoolId = actor.schoolId;

  // localId == users.id == identity_uid に共用する UUID (ADR-003)。
  const newUid = randomUUID();

  // 1) IdP を先に作成 (ADR-026)。teacher 固定 (role 境界)。メール重複は conflict、その他不明エラーは throw。
  let setupLink: string;
  try {
    ({ setupLink } = await createIdpUser({
      uid: newUid,
      email,
      displayName,
      role: "teacher",
      schoolId,
    }));
  } catch (error) {
    if (isEmailAlreadyExistsError(error)) {
      return conflict("このメールアドレスは既に登録されています。");
    }
    throw error;
  }

  // 2) DB mirror (users 行) + 監査を同一 tx で。失敗時は孤児 IdP user を補償削除して roll back。
  try {
    await withSession(
      async (tx, user) => {
        await tx.insert(users).values({
          id: newUid,
          identityUid: newUid,
          // 外側でガード済の非 null schoolId (= actor 自校 = RLS context)。WITH CHECK(school_id=current) を満たす。
          schoolId,
          role: "teacher",
          displayName,
          email,
          isActive: true,
          createdBy: user.uid,
          updatedBy: user.uid,
        });
        await tx.insert(auditLog).values({
          actorUserId: user.uid,
          schoolId: user.schoolId,
          tableName: "users",
          recordId: newUid,
          operation: "insert",
          diff: { after: { role: "teacher", displayName, email, isActive: true } },
          rowHash: "",
          createdBy: user.uid,
          updatedBy: user.uid,
        });
      },
      { allowedRoles: MEMBER_ADMIN_ROLES },
    );
  } catch (error) {
    // DB mirror 失敗 → DB 行の無い孤児 IdP user は管理不能なので補償削除 (best-effort) して原因を投げる。
    await deleteIdpUser(newUid).catch(() => {});
    throw error;
  }

  revalidatePath("/admin/school/members");
  return { ok: true, data: { id: newUid, setupLink } };
}
