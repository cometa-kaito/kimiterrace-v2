import { ONBOARDING_ROLES, validateTvOnboarding } from "@/lib/tv/onboarding-core";
import { describe, expect, it } from "vitest";

/**
 * F15 §4.3: TV デバイス新規登録の入力検証 `validateTvOnboarding` の単体テスト。設定フィールドの検証
 * （SSRF / URL / 長さ / schedule）は config-edit-core 側でテスト済なので、ここは **登録に固有な分岐**
 * （schoolId 必須 / deviceId 任意・自動採番・長さ / 委譲の連結）に絞る。
 */

const SCHOOL = "11111111-1111-4111-8111-111111111111";

describe("ONBOARDING_ROLES", () => {
  it("system_admin 限定（編集より狭い、cross-tenant のため）", () => {
    expect([...ONBOARDING_ROLES]).toEqual(["system_admin"]);
  });
});

describe("validateTvOnboarding", () => {
  it("schoolId が UUID でなければ拒否", () => {
    const r = validateTvOnboarding({ schoolId: "not-a-uuid" });
    expect(r.ok).toBe(false);
  });

  it("schoolId 未指定は拒否", () => {
    const r = validateTvOnboarding({});
    expect(r.ok).toBe(false);
  });

  it("deviceId 空欄なら null（= Action が自動採番）", () => {
    const r = validateTvOnboarding({ schoolId: SCHOOL, deviceId: "  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deviceId).toBeNull();
      expect(r.value.schoolId).toBe(SCHOOL);
    }
  });

  it("deviceId 指定は trim して保持", () => {
    const r = validateTvOnboarding({ schoolId: SCHOOL, deviceId: "  dev-abc  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deviceId).toBe("dev-abc");
    }
  });

  it("deviceId が上限超過なら拒否", () => {
    const r = validateTvOnboarding({ schoolId: SCHOOL, deviceId: "x".repeat(129) });
    expect(r.ok).toBe(false);
  });

  it("設定フィールド検証を委譲: 内部宛先 signageUrl は拒否（SSRF ガード）", () => {
    const r = validateTvOnboarding({
      schoolId: SCHOOL,
      signageUrl: "http://169.254.169.254/latest/meta-data/",
    });
    expect(r.ok).toBe(false);
  });

  it("正常系: 設定が正規化されて返る（空文字→null、monitoring 既定 true）", () => {
    const r = validateTvOnboarding({
      schoolId: SCHOOL,
      deviceId: "",
      label: "  電子工学科 1年  ",
      signageUrl: "https://sig.example/?x=1",
      targetMac: "",
      notes: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.config.label).toBe("電子工学科 1年");
      expect(r.value.config.signageUrl).toBe("https://sig.example/?x=1");
      expect(r.value.config.targetMac).toBeNull();
      expect(r.value.config.notes).toBeNull();
      expect(r.value.config.monitoringEnabled).toBe(true);
    }
  });
});
