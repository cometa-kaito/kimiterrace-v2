import type { TenantRole } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  MFA_ENROLLMENT_PATH,
  MFA_REQUIRED_ROLES,
  PATHNAME_HEADER,
  isMfaEnforcementEnabled,
  isMfaRequiredRole,
  shouldRedirectToMfaEnrollment,
} from "../../lib/mfa/policy";

/**
 * F11 (#47, ADR-031): MFA capability の純粋ロジック検証。副作用なしで node 環境で網羅する。
 */

const TENANT_ROLES: TenantRole[] = [
  "system_admin",
  "school_admin",
  "teacher",
  "student",
  "guardian",
];

describe("MFA_REQUIRED_ROLES / isMfaRequiredRole", () => {
  it("対象は teacher 以上 (system_admin / school_admin / teacher) の 3 つ (NFR03)", () => {
    expect([...MFA_REQUIRED_ROLES]).toEqual(["system_admin", "school_admin", "teacher"]);
  });

  it("teacher 以上は true、生徒・保護者は false (生徒は IdP アカウント無し、ADR-016)", () => {
    expect(isMfaRequiredRole("system_admin")).toBe(true);
    expect(isMfaRequiredRole("school_admin")).toBe(true);
    expect(isMfaRequiredRole("teacher")).toBe(true);
    expect(isMfaRequiredRole("student")).toBe(false);
    expect(isMfaRequiredRole("guardian")).toBe(false);
  });
});

describe("isMfaEnforcementEnabled (既定 OFF)", () => {
  it("env 未設定なら false (既定 OFF、PoC 非強制 ADR-031 §2)", () => {
    expect(isMfaEnforcementEnabled({})).toBe(false);
  });

  it("MFA_ENFORCEMENT='on' のときだけ true (大小無視・前後空白許容)", () => {
    expect(isMfaEnforcementEnabled({ MFA_ENFORCEMENT: "on" })).toBe(true);
    expect(isMfaEnforcementEnabled({ MFA_ENFORCEMENT: "ON" })).toBe(true);
    expect(isMfaEnforcementEnabled({ MFA_ENFORCEMENT: "  On  " })).toBe(true);
  });

  it("'on' 以外 (off / 空 / true / 1 / 任意) はすべて false (fail-safe: 設定ミスで全教職員をブロックしない)", () => {
    expect(isMfaEnforcementEnabled({ MFA_ENFORCEMENT: "off" })).toBe(false);
    expect(isMfaEnforcementEnabled({ MFA_ENFORCEMENT: "" })).toBe(false);
    expect(isMfaEnforcementEnabled({ MFA_ENFORCEMENT: "true" })).toBe(false);
    expect(isMfaEnforcementEnabled({ MFA_ENFORCEMENT: "1" })).toBe(false);
    expect(isMfaEnforcementEnabled({ MFA_ENFORCEMENT: "enabled" })).toBe(false);
  });
});

describe("shouldRedirectToMfaEnrollment (強制ゲート判定)", () => {
  it("既定 OFF (enforced=false) は role / 件数に関わらず常に false (既存ログイン挙動の不変・回帰なし)", () => {
    for (const role of TENANT_ROLES) {
      for (const count of [0, 1, 2]) {
        expect(shouldRedirectToMfaEnrollment(role, count, false)).toBe(false);
      }
    }
  });

  it("ON 時: 未登録 (0 件) の teacher 以上のみ誘導 true", () => {
    expect(shouldRedirectToMfaEnrollment("teacher", 0, true)).toBe(true);
    expect(shouldRedirectToMfaEnrollment("school_admin", 0, true)).toBe(true);
    expect(shouldRedirectToMfaEnrollment("system_admin", 0, true)).toBe(true);
  });

  it("ON 時: 登録済み (1 件以上) は誘導しない false", () => {
    expect(shouldRedirectToMfaEnrollment("teacher", 1, true)).toBe(false);
    expect(shouldRedirectToMfaEnrollment("school_admin", 2, true)).toBe(false);
  });

  it("ON 時: 対象外ロール (生徒・保護者) は未登録でも誘導しない false", () => {
    expect(shouldRedirectToMfaEnrollment("student", 0, true)).toBe(false);
    expect(shouldRedirectToMfaEnrollment("guardian", 0, true)).toBe(false);
  });

  it("負の件数 (異常値) も未登録扱いで ON 時に誘導 (堅牢性)", () => {
    expect(shouldRedirectToMfaEnrollment("teacher", -1, true)).toBe(true);
  });
});

describe("定数", () => {
  it("MFA_ENROLLMENT_PATH は /admin 配下 (requireRole で守られる)", () => {
    expect(MFA_ENROLLMENT_PATH).toBe("/app/account/mfa");
  });

  it("PATHNAME_HEADER は middleware / layout が共有する単一ソース", () => {
    expect(PATHNAME_HEADER).toBe("x-kt-pathname");
  });
});
