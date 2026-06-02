import { describe, expect, it } from "vitest";
import {
  type TvConfigEditInput,
  isUuid,
  validateSchedule,
  validateTvConfigEdit,
} from "../../lib/tv/config-edit-core";

/**
 * F15 §4.2 (ADR-022): TV 設定編集の純粋検証ロジックの単体テスト（postgres / 認可に依存しない）。
 * trim/空→null 正規化、URL 形式、長さ上限、schedule 形・範囲、システム管理列の非通過を検証する。
 */

describe("isUuid", () => {
  it("UUID は通し、非 UUID は弾く", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

describe("validateSchedule", () => {
  it("null/undefined は null（スケジュール無し）", () => {
    expect(validateSchedule(null)).toEqual({ ok: true, value: null });
    expect(validateSchedule(undefined)).toEqual({ ok: true, value: null });
  });
  it("enabled 必須 boolean、時刻は 0-23、weekdays は重複なし 0-6", () => {
    expect(validateSchedule({ enabled: true, onHour: 7, offHour: 19 })).toEqual({
      ok: true,
      value: { enabled: true, onHour: 7, offHour: 19 },
    });
    expect(validateSchedule({ enabled: "yes" }).ok).toBe(false);
    expect(validateSchedule({ enabled: true, onHour: 24 }).ok).toBe(false);
    expect(validateSchedule({ enabled: true, weekdays: [1, 1] }).ok).toBe(false);
    expect(validateSchedule({ enabled: true, weekdays: [7] }).ok).toBe(false);
  });
  it("weekdays は昇順に正規化し、余剰キーは落とす", () => {
    const r = validateSchedule({ enabled: true, weekdays: [6, 1, 3], junk: "x" });
    expect(r).toEqual({ ok: true, value: { enabled: true, weekdays: [1, 3, 6] } });
  });
});

describe("validateTvConfigEdit", () => {
  const base: TvConfigEditInput = {
    label: "電子工学科 1年",
    signageUrl: "https://sig.example/?school=A",
    targetMac: "DC:A5:B3:C2:98:A1",
    monitoringEnabled: true,
    schedule: { enabled: true, onHour: 8 },
  };

  it("正常系: trim 正規化 + schedule 反映", () => {
    const r = validateTvConfigEdit({ ...base, label: "  電子工学科 1年  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBe("電子工学科 1年");
      expect(r.value.signageUrl).toBe("https://sig.example/?school=A");
      expect(r.value.scheduleJson).toEqual({ enabled: true, onHour: 8 });
      expect(r.value.monitoringEnabled).toBe(true);
    }
  });

  it("空文字は null（クリア）に正規化", () => {
    const r = validateTvConfigEdit({ ...base, label: "  ", signageUrl: "", targetMac: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBeNull();
      expect(r.value.signageUrl).toBeNull();
      expect(r.value.targetMac).toBeNull();
    }
  });

  it("非 http(s) URL は拒否（javascript: / 相対）", () => {
    expect(validateTvConfigEdit({ ...base, signageUrl: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateTvConfigEdit({ ...base, signageUrl: "/relative/path" }).ok).toBe(false);
    expect(validateTvConfigEdit({ ...base, webhookUrl: "ftp://x" }).ok).toBe(false);
  });

  it("長さ超過は拒否（label/notes）", () => {
    expect(validateTvConfigEdit({ ...base, label: "あ".repeat(201) }).ok).toBe(false);
    expect(validateTvConfigEdit({ ...base, notes: "x".repeat(2001) }).ok).toBe(false);
  });

  it("monitoringEnabled 未指定は true 既定、非 boolean は拒否", () => {
    const r = validateTvConfigEdit({ label: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.monitoringEnabled).toBe(true);
    expect(validateTvConfigEdit({ monitoringEnabled: "true" as unknown as boolean }).ok).toBe(
      false,
    );
  });

  it("システム管理列はパッチに通らない（version / deviceId 等を入れても黙殺）", () => {
    const r = validateTvConfigEdit({
      ...base,
      // 型外の余剰キー（攻撃的入力の模擬）。
      version: 999,
      deviceId: "evil",
      schoolId: "00000000-0000-0000-0000-000000000000",
    } as TvConfigEditInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toHaveProperty("version");
      expect(r.value).not.toHaveProperty("deviceId");
      expect(r.value).not.toHaveProperty("schoolId");
    }
  });
});
