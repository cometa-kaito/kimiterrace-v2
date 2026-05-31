import type { TenantRole } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  type RoleActor,
  canAssignRole,
  canChangeRole,
  canDisableAccount,
  canModifyTargetUser,
} from "../../lib/role-management/policy";

/**
 * F11 (#47): ロール認可ポリシーの権限マトリクスを網羅的に固定する。
 * 副作用なしの純関数なので mock 不要。仕様 F11-role-management.md のマトリクスを表で照合する。
 */

const SCHOOL_A = "school-a";
const SCHOOL_B = "school-b";

const systemAdmin: RoleActor = { role: "system_admin", schoolId: null };
const schoolAdminA: RoleActor = { role: "school_admin", schoolId: SCHOOL_A };
const teacherA: RoleActor = { role: "teacher", schoolId: SCHOOL_A };
const studentA: RoleActor = { role: "student", schoolId: SCHOOL_A };
const guardianA: RoleActor = { role: "guardian", schoolId: SCHOOL_A };

const ALL_ROLES: TenantRole[] = ["system_admin", "school_admin", "teacher", "student", "guardian"];

describe("canAssignRole", () => {
  it("system_admin は全ロールを任意の校に付与できる", () => {
    for (const targetRole of ALL_ROLES) {
      expect(canAssignRole(systemAdmin, { targetRole, targetSchoolId: SCHOOL_A })).toEqual({
        allowed: true,
      });
    }
  });

  it("school_admin は自校の teacher のみ付与できる", () => {
    expect(
      canAssignRole(schoolAdminA, { targetRole: "teacher", targetSchoolId: SCHOOL_A }),
    ).toEqual({ allowed: true });
  });

  it("school_admin は teacher 以外を付与できない（school_admin / system_admin など）", () => {
    expect(
      canAssignRole(schoolAdminA, { targetRole: "school_admin", targetSchoolId: SCHOOL_A }),
    ).toEqual({ allowed: false, reason: "target_role_not_assignable" });
    expect(
      canAssignRole(schoolAdminA, { targetRole: "system_admin", targetSchoolId: SCHOOL_A }),
    ).toEqual({ allowed: false, reason: "target_role_not_assignable" });
  });

  it("school_admin は他校の teacher を付与できない（cross_school）", () => {
    expect(
      canAssignRole(schoolAdminA, { targetRole: "teacher", targetSchoolId: SCHOOL_B }),
    ).toEqual({ allowed: false, reason: "cross_school" });
  });

  it("所属校を持たない school_admin は付与できない（missing_school_scope）", () => {
    const orphan: RoleActor = { role: "school_admin", schoolId: null };
    expect(canAssignRole(orphan, { targetRole: "teacher", targetSchoolId: SCHOOL_A })).toEqual({
      allowed: false,
      reason: "missing_school_scope",
    });
  });

  it("teacher / student / guardian はロールを付与できない", () => {
    for (const actor of [teacherA, studentA, guardianA]) {
      expect(canAssignRole(actor, { targetRole: "teacher", targetSchoolId: SCHOOL_A })).toEqual({
        allowed: false,
        reason: "actor_not_privileged",
      });
    }
  });
});

describe("canModifyTargetUser / canDisableAccount", () => {
  it("system_admin は全ユーザーを操作・無効化できる", () => {
    for (const targetCurrentRole of ALL_ROLES) {
      expect(
        canModifyTargetUser(systemAdmin, { targetCurrentRole, targetSchoolId: SCHOOL_B }),
      ).toEqual({ allowed: true });
      expect(
        canDisableAccount(systemAdmin, { targetCurrentRole, targetSchoolId: SCHOOL_B }),
      ).toEqual({ allowed: true });
    }
  });

  it("school_admin は自校 teacher のみ操作・無効化できる", () => {
    expect(
      canModifyTargetUser(schoolAdminA, { targetCurrentRole: "teacher", targetSchoolId: SCHOOL_A }),
    ).toEqual({ allowed: true });
    expect(
      canDisableAccount(schoolAdminA, { targetCurrentRole: "teacher", targetSchoolId: SCHOOL_A }),
    ).toEqual({ allowed: true });
  });

  it("school_admin は teacher 以外（school_admin 自身ら）を操作できない（target_not_teacher）", () => {
    expect(
      canModifyTargetUser(schoolAdminA, {
        targetCurrentRole: "school_admin",
        targetSchoolId: SCHOOL_A,
      }),
    ).toEqual({ allowed: false, reason: "target_not_teacher" });
  });

  it("school_admin は他校 teacher を操作できない（cross_school）", () => {
    expect(
      canModifyTargetUser(schoolAdminA, { targetCurrentRole: "teacher", targetSchoolId: SCHOOL_B }),
    ).toEqual({ allowed: false, reason: "cross_school" });
  });

  it("teacher は他者を操作できない", () => {
    expect(
      canModifyTargetUser(teacherA, { targetCurrentRole: "teacher", targetSchoolId: SCHOOL_A }),
    ).toEqual({ allowed: false, reason: "actor_not_privileged" });
  });
});

describe("空文字 schoolId は未設定として弾く（client.ts の sentinel 規律）", () => {
  it("空文字所属の school_admin は付与できない（missing_school_scope）", () => {
    const emptyScope: RoleActor = { role: "school_admin", schoolId: "" };
    expect(canAssignRole(emptyScope, { targetRole: "teacher", targetSchoolId: "" })).toEqual({
      allowed: false,
      reason: "missing_school_scope",
    });
    expect(
      canModifyTargetUser(emptyScope, { targetCurrentRole: "teacher", targetSchoolId: "" }),
    ).toEqual({ allowed: false, reason: "missing_school_scope" });
  });

  it("有効校の school_admin は空文字 target 校を自校扱いしない（cross_school）", () => {
    expect(canAssignRole(schoolAdminA, { targetRole: "teacher", targetSchoolId: "" })).toEqual({
      allowed: false,
      reason: "cross_school",
    });
  });
});

describe("canChangeRole", () => {
  it("school_admin は自校 teacher を teacher のまま再付与できる（対象ゲート∧付与可の合成 ALLOWED）", () => {
    expect(
      canChangeRole(schoolAdminA, {
        targetCurrentRole: "teacher",
        targetSchoolId: SCHOOL_A,
        nextRole: "teacher",
      }),
    ).toEqual({ allowed: true });
  });

  it("system_admin は teacher を school_admin に昇格できる", () => {
    expect(
      canChangeRole(systemAdmin, {
        targetCurrentRole: "teacher",
        targetSchoolId: SCHOOL_A,
        nextRole: "school_admin",
      }),
    ).toEqual({ allowed: true });
  });

  it("school_admin は自校 teacher の teacher 維持変更はできるが、昇格はできない", () => {
    // 対象ゲートは通る（自校 teacher）が、nextRole=school_admin は付与不可。
    expect(
      canChangeRole(schoolAdminA, {
        targetCurrentRole: "teacher",
        targetSchoolId: SCHOOL_A,
        nextRole: "school_admin",
      }),
    ).toEqual({ allowed: false, reason: "target_role_not_assignable" });
  });

  it("対象ゲートの拒否理由を新ロール検査より優先する", () => {
    // 他校 teacher → 対象ゲートで cross_school 拒否（nextRole は評価しない）。
    expect(
      canChangeRole(schoolAdminA, {
        targetCurrentRole: "teacher",
        targetSchoolId: SCHOOL_B,
        nextRole: "teacher",
      }),
    ).toEqual({ allowed: false, reason: "cross_school" });
  });

  it("school_admin が他校の school_admin を変更しようとすると target_not_teacher を先に返す", () => {
    expect(
      canChangeRole(schoolAdminA, {
        targetCurrentRole: "school_admin",
        targetSchoolId: SCHOOL_B,
        nextRole: "teacher",
      }),
    ).toEqual({ allowed: false, reason: "target_not_teacher" });
  });
});
