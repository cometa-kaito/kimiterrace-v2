import { describe, expect, it } from "vitest";
import {
  GINAN_ECE_DEPARTMENT_NAME,
  GINAN_ECE_SENSOR_DEVICES,
  GINAN_SCHOOL_NAME,
  type GinanSensorSeedDevice,
  canonicalizeMac,
  validateGinanSeedDevices,
} from "../../src/seed-ginan-sensors.js";

/**
 * F13 (#391, ADR-020): 岐南工業 電子工学科 1〜3 年 SwitchBot シードデータの単体検証。I/O 非依存（DB 不要）。
 * 実 MAC（PoC 本番の実値）が webhook ingest と同じ正規形で保存されること・学年カバレッジ・PII 非格納を固定する。
 */

describe("canonicalizeMac", () => {
  it("コロン区切りを除去し大文字化する", () => {
    expect(canonicalizeMac("dc:a5:b3:c2:98:d7")).toBe("DCA5B3C298D7");
  });

  it("ハイフン・空白区切りも除去する", () => {
    expect(canonicalizeMac("EF-64-49-02-A1-0D")).toBe("EF644902A10D");
    expect(canonicalizeMac("E2 E2 E8 85 3A 32")).toBe("E2E2E8853A32");
  });

  it("既に正規形ならそのまま（冪等）", () => {
    expect(canonicalizeMac("E2E2E8853A32")).toBe("E2E2E8853A32");
  });
});

describe("GINAN_ECE_SENSOR_DEVICES", () => {
  it("電子工学科 1〜3 年の 3 台ちょうど（各学年 1 台）", () => {
    expect(GINAN_ECE_SENSOR_DEVICES).toHaveLength(3);
    const grades = GINAN_ECE_SENSOR_DEVICES.map((d) => d.grade).sort();
    expect(grades).toEqual([1, 2, 3]);
  });

  it("各 deviceMac は rawMac の正規形（webhook ingest と一致する保存形）", () => {
    for (const d of GINAN_ECE_SENSOR_DEVICES) {
      expect(d.deviceMac).toBe(canonicalizeMac(d.rawMac));
      expect(d.deviceMac).toMatch(/^[0-9A-F]{12}$/);
    }
  });

  it("PoC 本番（tv_devices.target_mac）の実 MAC と一致する", () => {
    const byGrade = new Map(GINAN_ECE_SENSOR_DEVICES.map((d) => [d.grade, d.rawMac]));
    expect(byGrade.get(1)).toBe("DC:A5:B3:C2:98:D7");
    expect(byGrade.get(2)).toBe("EF:64:49:02:A1:0D");
    expect(byGrade.get(3)).toBe("E2:E2:E8:85:3A:32");
  });

  it("deviceMac はグローバル一意（解決の一意写像 / テナント越境防止）", () => {
    const macs = GINAN_ECE_SENSOR_DEVICES.map((d) => d.deviceMac);
    expect(new Set(macs).size).toBe(macs.length);
  });

  it("locationLabel は『電子工学科 N年』で PII（氏名・電話）を含まない", () => {
    for (const d of GINAN_ECE_SENSOR_DEVICES) {
      expect(d.locationLabel).toBe(`電子工学科 ${d.grade}年`);
      expect(d.locationLabel.length).toBeLessThanOrEqual(120);
      // 電話番号らしき数字列を含まない（PII 混入の粗い検出）。
      expect(d.locationLabel).not.toMatch(/\d{2,}/);
    }
  });
});

describe("validateGinanSeedDevices", () => {
  it("既定のシードは妥当（throw しない）", () => {
    expect(() => validateGinanSeedDevices()).not.toThrow();
  });

  it("deviceMac が rawMac の正規形でなければ throw", () => {
    const bad: GinanSensorSeedDevice[] = [
      {
        grade: 1,
        rawMac: "DC:A5:B3:C2:98:D7",
        deviceMac: "FFFFFFFFFFFF",
        locationLabel: "電子工学科 1年",
      },
    ];
    expect(() => validateGinanSeedDevices(bad)).toThrow();
  });

  it("deviceMac が重複していれば throw", () => {
    const dup: GinanSensorSeedDevice[] = [
      {
        grade: 1,
        rawMac: "DC:A5:B3:C2:98:D7",
        deviceMac: "DCA5B3C298D7",
        locationLabel: "電子工学科 1年",
      },
      {
        grade: 2,
        rawMac: "DC:A5:B3:C2:98:D7",
        deviceMac: "DCA5B3C298D7",
        locationLabel: "電子工学科 2年",
      },
    ];
    expect(() => validateGinanSeedDevices(dup)).toThrow();
  });

  it("空配列は throw", () => {
    expect(() => validateGinanSeedDevices([])).toThrow();
  });
});

describe("解決キー定数", () => {
  it("学校名・学科名がユーザー確定値", () => {
    expect(GINAN_SCHOOL_NAME).toBe("岐阜県立岐南工業高等学校");
    expect(GINAN_ECE_DEPARTMENT_NAME).toBe("電子工学科");
  });
});
