import { describe, expect, it } from "vitest";
import { isValidIpv4, validateProvisioningInput } from "../../lib/tv/provisioning-core";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const CLASS = "22222222-2222-4222-8222-222222222222";

describe("provisioning-core: isValidIpv4", () => {
  it.each(["192.168.1.50", "10.0.0.1", "0.0.0.0", "255.255.255.255"])("valid: %s", (ip) => {
    expect(isValidIpv4(ip)).toBe(true);
  });
  it.each([
    "192.168.1",
    "192.168.1.256",
    "1.2.3.4.5",
    "abc",
    "",
    "192.168.1.x",
    "....",
  ])("invalid: %s", (ip) => {
    expect(isValidIpv4(ip)).toBe(false);
  });
});

describe("provisioning-core: validateProvisioningInput", () => {
  it("schoolId 無効 → 拒否", () => {
    expect(validateProvisioningInput({ schoolId: "nope", classId: CLASS }).ok).toBe(false);
  });

  it("classId 無効 → 拒否", () => {
    expect(validateProvisioningInput({ schoolId: SCHOOL, classId: "nope" }).ok).toBe(false);
  });

  it("最小（school/class のみ）→ ok。deviceId/targetIp は null、signageUrl は発行ゆえ config では null", () => {
    const r = validateProvisioningInput({ schoolId: SCHOOL, classId: CLASS });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deviceId).toBeNull();
      expect(r.value.targetIp).toBeNull();
      expect(r.value.config.signageUrl).toBeNull();
      expect(r.value.config.webhookUrl).toBeNull();
      expect(r.value.config.monitoringEnabled).toBe(true);
    }
  });

  it("deviceId 長すぎ → 拒否", () => {
    const r = validateProvisioningInput({
      schoolId: SCHOOL,
      classId: CLASS,
      deviceId: "a".repeat(129),
    });
    expect(r.ok).toBe(false);
  });

  it("deviceId 指定（trim）→ 採用", () => {
    const r = validateProvisioningInput({
      schoolId: SCHOOL,
      classId: CLASS,
      deviceId: "  dev-1  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deviceId).toBe("dev-1");
    }
  });

  it("targetIp 不正 → 拒否", () => {
    expect(
      validateProvisioningInput({ schoolId: SCHOOL, classId: CLASS, targetIp: "999.1.1.1" }).ok,
    ).toBe(false);
  });

  it("targetIp 正常 → 採用", () => {
    const r = validateProvisioningInput({
      schoolId: SCHOOL,
      classId: CLASS,
      targetIp: "192.168.1.50",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.targetIp).toBe("192.168.1.50");
    }
  });

  it("config 検証は委譲（不正 schedule → 拒否）", () => {
    expect(
      validateProvisioningInput({ schoolId: SCHOOL, classId: CLASS, schedule: { enabled: "yes" } })
        .ok,
    ).toBe(false);
  });

  it("label/schedule 正常 → config に反映（平日 08:00-17:00）", () => {
    const r = validateProvisioningInput({
      schoolId: SCHOOL,
      classId: CLASS,
      label: "電子工学科 1年",
      schedule: { enabled: true, onHour: 8, offHour: 17, weekdays: [1, 2, 3, 4, 5] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.config.label).toBe("電子工学科 1年");
      expect(r.value.config.scheduleJson).toEqual({
        enabled: true,
        onHour: 8,
        offHour: 17,
        weekdays: [1, 2, 3, 4, 5],
      });
    }
  });
});
