import type { TenantRole } from "@kimiterrace/db";

/**
 * F11 (#47 第1スライス): ロール管理の **認可ポリシー（純粋ロジック）**。
 *
 * 「誰が・誰に・どのロールを付与/変更/無効化できるか」を F11 仕様
 * [docs/requirements/functional/F11-role-management.md] の権限マトリクスどおりに決定する。
 * 副作用なし（DB / Identity Platform に触れない）ので mock 不要で網羅的に unit テストできる。
 *
 * **多層防御の位置づけ（CLAUDE.md ルール2）**: 本モジュールは認可の **アプリ早期 gate**。
 * 実際のロール書込み（custom claims 更新）は特権ロール経由の server 側でのみ行い、`memberships` の
 * RLS（`tenant_isolation` / `system_admin_full_access`）が DB レベルの最終境界を張る。
 * `memberships` の RLS は **school 境界しか守らない**（[[rls-tenant-not-role-boundary]]）ため、
 * 「school_admin は teacher しか任命できない」等の **role 境界はここ + handler が強制**する。
 *
 * **このスライスの境界（正直に明記）**: 純粋な判定関数のみ。Server Action / Route Handler への
 * 配線、custom claims 更新、audit_log への記録、MFA 強制（NFR03）は後続スライス。本モジュールが
 * 返す {@link RoleDecision} を handler が消費して 403 / 実行を分岐する想定。
 *
 * **対象外**: 自分自身のパスワード変更等の self-service（他者のロール/アカウント操作ではない）は
 * 本ポリシーの範囲外。ここは **他者** に対するロール付与・変更・無効化のみを扱う。
 */

/** 認可を要求する操作の主体。`schoolId` は所属校（system_admin はテナント外のため null）。 */
export interface RoleActor {
  role: TenantRole;
  /** 所属校 ID。system_admin は null。school_admin / teacher は自校 ID。 */
  schoolId: string | null;
}

/** 認可判定の結果。拒否時は機械判別可能な理由を持つ（handler のログ/メッセージ分岐用）。 */
export type RoleDecision = { allowed: true } | { allowed: false; reason: RoleDenyReason };

/** 拒否理由。 */
export type RoleDenyReason =
  /** 主体が teacher / student / guardian 等、ロール管理権限を持たない。 */
  | "actor_not_privileged"
  /** school_admin が所属校を持たない（schoolId=null）ため自校スコープを構成できない。 */
  | "missing_school_scope"
  /** school_admin が自校外のユーザーを操作しようとした。 */
  | "cross_school"
  /** school_admin が teacher 以外のロールを付与しようとした（school_admin は teacher のみ任命可）。 */
  | "target_role_not_assignable"
  /** school_admin が teacher 以外（school_admin / system_admin 等）を変更/無効化しようとした。 */
  | "target_not_teacher";

const ALLOWED: RoleDecision = { allowed: true };
const deny = (reason: RoleDenyReason): RoleDecision => ({ allowed: false, reason });

/** `actor.schoolId` が非 null かつ `targetSchoolId` と一致するか（自校スコープ）。 */
function isSameSchool(actor: RoleActor, targetSchoolId: string | null): boolean {
  return actor.schoolId != null && actor.schoolId === targetSchoolId;
}

/**
 * `actor` が、`targetSchoolId` 所属のユーザーへ `targetRole` を **新規付与**できるか。
 *
 * マトリクス:
 * - `system_admin`: 全ロール付与可（school 制約なし）。
 * - `school_admin`: 自校の `teacher` のみ付与可。
 * - `teacher` / `student` / `guardian`: 不可。
 */
export function canAssignRole(
  actor: RoleActor,
  target: { targetRole: TenantRole; targetSchoolId: string | null },
): RoleDecision {
  switch (actor.role) {
    case "system_admin":
      return ALLOWED;
    case "school_admin":
      if (actor.schoolId == null) return deny("missing_school_scope");
      if (target.targetRole !== "teacher") return deny("target_role_not_assignable");
      if (!isSameSchool(actor, target.targetSchoolId)) return deny("cross_school");
      return ALLOWED;
    case "teacher":
    case "student":
    case "guardian":
      return deny("actor_not_privileged");
    default:
      return assertNeverRole(actor.role);
  }
}

/**
 * `actor` が、現在ロール `targetCurrentRole`・所属 `targetSchoolId` の **他ユーザーを操作対象に
 * できるか**（ロール変更・アカウント無効化に共通の対象ゲート）。
 *
 * マトリクス（他者のロール変更 / アカウント無効化）:
 * - `system_admin`: 全ユーザー可。
 * - `school_admin`: 自校の `teacher` のみ可。
 * - その他: 不可。
 *
 * 付与する **新ロール** の妥当性は別途 {@link canAssignRole} で確認する（本関数は対象ゲートのみ）。
 */
export function canModifyTargetUser(
  actor: RoleActor,
  target: { targetCurrentRole: TenantRole; targetSchoolId: string | null },
): RoleDecision {
  switch (actor.role) {
    case "system_admin":
      return ALLOWED;
    case "school_admin":
      if (actor.schoolId == null) return deny("missing_school_scope");
      if (target.targetCurrentRole !== "teacher") return deny("target_not_teacher");
      if (!isSameSchool(actor, target.targetSchoolId)) return deny("cross_school");
      return ALLOWED;
    case "teacher":
    case "student":
    case "guardian":
      return deny("actor_not_privileged");
    default:
      return assertNeverRole(actor.role);
  }
}

/**
 * `actor` が対象ユーザーのアカウントを **無効化**できるか。マトリクス上「アカウント無効化」は
 * 「他者のロール変更」と同一の対象ゲートのため {@link canModifyTargetUser} に委譲する（単一ソース）。
 */
export function canDisableAccount(
  actor: RoleActor,
  target: { targetCurrentRole: TenantRole; targetSchoolId: string | null },
): RoleDecision {
  return canModifyTargetUser(actor, target);
}

/**
 * `actor` が対象ユーザーのロールを `nextRole` へ **変更**できるか。対象ゲート
 * （{@link canModifyTargetUser}）と新ロール付与可否（{@link canAssignRole}）の **両方**を満たす
 * 必要がある。先に対象ゲートを評価し、その拒否理由を優先して返す。
 */
export function canChangeRole(
  actor: RoleActor,
  target: {
    targetCurrentRole: TenantRole;
    targetSchoolId: string | null;
    nextRole: TenantRole;
  },
): RoleDecision {
  const gate = canModifyTargetUser(actor, {
    targetCurrentRole: target.targetCurrentRole,
    targetSchoolId: target.targetSchoolId,
  });
  if (!gate.allowed) return gate;
  return canAssignRole(actor, {
    targetRole: target.nextRole,
    targetSchoolId: target.targetSchoolId,
  });
}

/** `switch` の網羅性をコンパイル時に担保する（新ロール追加時に build を落とす、ルール3）。 */
function assertNeverRole(role: never): never {
  throw new Error(`unhandled role: ${String(role)}`);
}
