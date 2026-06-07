import { describe, expect, it } from "vitest";
import { canonicalizeMac } from "../../src/seed-ginan-sensors.js";
import {
  GINAN_ECE_DEPARTMENT_NAME,
  GINAN_ECE_TV_DEVICES,
  GINAN_SCHOOL_NAME,
  GINAN_TV_DEFAULT_SCHEDULE,
  type GinanTvSeedDevice,
  validateGinanTvSeedDevices,
} from "../../src/seed-ginan-tv-devices.js";

/**
 * F15 (ADR-022): 岐南工業 電子工学科 1〜3 年 TV デバイスシードデータの単体検証。I/O 非依存（DB 不要）。
 * device_id の一意性・形式、target_mac が同教室センサーの実 MAC と一致すること、既定スケジュール、PII 非格納を固定する。
 */

describe("GINAN_ECE_TV_DEVICES", () => {
  it("電子工学科 1〜3 年の 3 台ちょうど（各学年 1 台）", () => {
    expect(GINAN_ECE_TV_DEVICES).toHaveLength(3);
    const grades = GINAN_ECE_TV_DEVICES.map((d) => d.grade).sort();
    expect(grades).toEqual([1, 2, 3]);
  });

  it("device_id はグローバル一意（ポーリング解決の一意写像 / テナント越境配信防止）", () => {
    const ids = GINAN_ECE_TV_DEVICES.map((d) => d.deviceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("device_id は UUID 形式（体裁固定）", () => {
    for (const d of GINAN_ECE_TV_DEVICES) {
      expect(d.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("target_mac は同教室センサーの PoC 本番実 MAC（コロン区切り生形式）と一致する", () => {
    const byGrade = new Map(GINAN_ECE_TV_DEVICES.map((d) => [d.grade, d.targetMac]));
    expect(byGrade.get(1)).toBe("DC:A5:B3:C2:98:D7");
    expect(byGrade.get(2)).toBe("EF:64:49:02:A1:0D");
    expect(byGrade.get(3)).toBe("E2:E2:E8:85:3A:32");
  });

  it("target_mac は正規化すると 12 桁 hex（sensor_devices.device_mac の正規形と対応）", () => {
    for (const d of GINAN_ECE_TV_DEVICES) {
      expect(canonicalizeMac(d.targetMac)).toMatch(/^[0-9A-F]{12}$/);
    }
  });

  it("label は『電子工学科 N年』で PII（氏名・電話）を含まない", () => {
    for (const d of GINAN_ECE_TV_DEVICES) {
      expect(d.label).toBe(`電子工学科 ${d.grade}年`);
      expect(d.label.length).toBeLessThanOrEqual(200);
      // 電話番号らしき数字列を含まない（PII 混入の粗い検出）。
      expect(d.label).not.toMatch(/\d{2,}/);
    }
  });
});

describe("GINAN_TV_DEFAULT_SCHEDULE", () => {
  it("平日（月〜金）08:00〜17:00 の妥当な既定", () => {
    expect(GINAN_TV_DEFAULT_SCHEDULE.enabled).toBe(true);
    expect(GINAN_TV_DEFAULT_SCHEDULE.onHour).toBe(8);
    expect(GINAN_TV_DEFAULT_SCHEDULE.offHour).toBe(17);
    expect(GINAN_TV_DEFAULT_SCHEDULE.weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  it("weekdays は 0=日..6=土 の範囲", () => {
    for (const w of GINAN_TV_DEFAULT_SCHEDULE.weekdays ?? []) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(6);
    }
  });
});

describe("validateGinanTvSeedDevices", () => {
  it("既定のシードは妥当（throw しない）", () => {
    expect(() => validateGinanTvSeedDevices()).not.toThrow();
  });

  it("device_id が UUID 形式でなければ throw", () => {
    const bad: GinanTvSeedDevice[] = [
      { grade: 1, deviceId: "not-a-uuid", label: "電子工学科 1年", targetMac: "DC:A5:B3:C2:98:D7" },
    ];
    expect(() => validateGinanTvSeedDevices(bad)).toThrow();
  });

  it("device_id が重複していれば throw", () => {
    const dup: GinanTvSeedDevice[] = [
      {
        grade: 1,
        deviceId: "0e1c0001-5ace-4b0e-9c00-000000000001",
        label: "電子工学科 1年",
        targetMac: "DC:A5:B3:C2:98:D7",
      },
      {
        grade: 2,
        deviceId: "0e1c0001-5ace-4b0e-9c00-000000000001",
        label: "電子工学科 2年",
        targetMac: "EF:64:49:02:A1:0D",
      },
    ];
    expect(() => validateGinanTvSeedDevices(dup)).toThrow();
  });

  it("target_mac が 6 オクテット MAC でなければ throw", () => {
    const bad: GinanTvSeedDevice[] = [
      {
        grade: 1,
        deviceId: "0e1c0001-5ace-4b0e-9c00-000000000001",
        label: "電子工学科 1年",
        targetMac: "ZZ:ZZ",
      },
    ];
    expect(() => validateGinanTvSeedDevices(bad)).toThrow();
  });

  it("空配列は throw", () => {
    expect(() => validateGinanTvSeedDevices([])).toThrow();
  });
});

describe("解決キー定数", () => {
  it("学校名・学科名は sensor シードと共有のユーザー確定値", () => {
    expect(GINAN_SCHOOL_NAME).toBe("岐阜県立岐南工業高等学校");
    expect(GINAN_ECE_DEPARTMENT_NAME).toBe("電子工学科");
  });
});
