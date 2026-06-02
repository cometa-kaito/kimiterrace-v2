import { describe, expect, it } from "vitest";
import {
  SENSOR_WRITE_ROLES,
  normalizeClassId,
  normalizeLocationLabel,
  validateAndNormalizeMac,
  validateCreateSensorInput,
  validateUpdateSensorInput,
} from "../../lib/sensors/mutations-core";

/**
 * F13 (#391, ADR-020): センサー登録/編集の検証・正規化ロジック (mutations-core) の純粋テスト。
 * DB / next には触れない。MAC 正規化 (大小・区切りゆれ吸収)・長さ上限・任意フィールドの境界を pin する。
 */

describe("SENSOR_WRITE_ROLES", () => {
  it("school_admin のみ (teacher / system_admin を含まない = teacher は書けない)", () => {
    expect(SENSOR_WRITE_ROLES).toEqual(["school_admin"]);
  });
});

describe("validateAndNormalizeMac", () => {
  it("コロン区切りを大文字・区切り無しへ正規化する", () => {
    expect(validateAndNormalizeMac("aa:bb:cc:dd:ee:ff")).toEqual({
      ok: true,
      mac: "AABBCCDDEEFF",
    });
  });
  it("区切り無し / ハイフン / 空白混在も同じ正規形に揃う", () => {
    expect(validateAndNormalizeMac("AABBCCDDEEFF")).toEqual({ ok: true, mac: "AABBCCDDEEFF" });
    expect(validateAndNormalizeMac("aa-bb-cc-dd-ee-ff")).toEqual({
      ok: true,
      mac: "AABBCCDDEEFF",
    });
    expect(validateAndNormalizeMac(" aa bb cc dd ee ff ")).toEqual({
      ok: true,
      mac: "AABBCCDDEEFF",
    });
  });
  it("16 進でない / 桁数不足 / 非文字列は拒否", () => {
    expect(validateAndNormalizeMac("zz:bb:cc:dd:ee:ff").ok).toBe(false);
    expect(validateAndNormalizeMac("AABBCCDDEE").ok).toBe(false); // 10 桁
    expect(validateAndNormalizeMac("AABBCCDDEEFFFF").ok).toBe(false); // 14 桁
    expect(validateAndNormalizeMac(123).ok).toBe(false);
    expect(validateAndNormalizeMac(null).ok).toBe(false);
  });
});

describe("normalizeLocationLabel", () => {
  it("空 / 未指定は null", () => {
    expect(normalizeLocationLabel("")).toEqual({ ok: true, label: null });
    expect(normalizeLocationLabel(undefined)).toEqual({ ok: true, label: null });
    expect(normalizeLocationLabel("   ")).toEqual({ ok: true, label: null });
  });
  it("前後空白を除去して保持", () => {
    expect(normalizeLocationLabel("  1-A 前  ")).toEqual({ ok: true, label: "1-A 前" });
  });
  it("120 文字超は拒否", () => {
    expect(normalizeLocationLabel("あ".repeat(121)).ok).toBe(false);
    expect(normalizeLocationLabel("あ".repeat(120))).toEqual({
      ok: true,
      label: "あ".repeat(120),
    });
  });
});

describe("normalizeClassId", () => {
  it("空 / 未指定は null", () => {
    expect(normalizeClassId("")).toEqual({ ok: true, classId: null });
    expect(normalizeClassId(undefined)).toEqual({ ok: true, classId: null });
  });
  it("UUID 形式のみ許可", () => {
    expect(normalizeClassId("44444444-4444-4444-8444-444444444444")).toEqual({
      ok: true,
      classId: "44444444-4444-4444-8444-444444444444",
    });
    expect(normalizeClassId("not-a-uuid").ok).toBe(false);
  });
});

describe("validateCreateSensorInput", () => {
  it("正常系: MAC を正規化し location / class を返す", () => {
    const res = validateCreateSensorInput({
      deviceMac: "AA:BB:CC:DD:EE:FF",
      locationLabel: "玄関",
      classId: "44444444-4444-4444-8444-444444444444",
    });
    expect(res).toEqual({
      ok: true,
      value: {
        deviceMac: "AABBCCDDEEFF",
        locationLabel: "玄関",
        classId: "44444444-4444-4444-8444-444444444444",
      },
    });
  });
  it("MAC 不正なら 1 項目でも全体を拒否", () => {
    expect(validateCreateSensorInput({ deviceMac: "bad" }).ok).toBe(false);
  });
});

describe("validateUpdateSensorInput", () => {
  it("location / class のみ (MAC は対象外)", () => {
    const res = validateUpdateSensorInput({ locationLabel: "職員室", classId: "" });
    expect(res).toEqual({ ok: true, value: { locationLabel: "職員室", classId: null } });
  });
});
