import { describe, expect, it } from "vitest";
import { MFA_ENROLLMENT_PATH, MFA_REQUIRED_ROLES, isMfaRequiredRole } from "../../lib/mfa/policy";

/**
 * F11 (#47, ADR-031): MFA capability の純粋ロジック検証 (enrollment スライス分)。
 * 副作用なしで node 環境で網羅する。強制ゲート (env フラグ・誘導判定) のテストは後続スライスで追加。
 */

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

describe("定数", () => {
  it("MFA_ENROLLMENT_PATH は /admin 配下 (requireRole で守られる)", () => {
    expect(MFA_ENROLLMENT_PATH).toBe("/admin/account/mfa");
  });
});
