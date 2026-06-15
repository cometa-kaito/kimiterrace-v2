import { describe, expect, it } from "vitest";
import {
  GINAN_DEPARTMENT,
  GINAN_GRADES,
  GINAN_SCHOOL,
  type GinanGradeSeed,
  validateGinanSchoolSeed,
} from "../../src/seed-ginan-school.js";

/**
 * 岐南工業テナント（学校 + 電子工学科 + 1〜3 年 + 各 1 クラス）シードデータの単体検証。DB 非依存。
 */

describe("GINAN_SCHOOL / GINAN_DEPARTMENT", () => {
  it("学校はユーザー確定値・学科制", () => {
    expect(GINAN_SCHOOL.name).toBe("岐阜県立岐南工業高等学校");
    expect(GINAN_SCHOOL.prefecture).toBe("岐阜県");
    expect(GINAN_SCHOOL.hierarchyMode).toBe("department");
    expect(GINAN_DEPARTMENT).toBe("電子工学科");
  });
});

describe("GINAN_GRADES", () => {
  it("電子工学科 1〜3 年の 3 学年（各 1 クラス）", () => {
    expect(GINAN_GRADES).toHaveLength(3);
    expect(GINAN_GRADES.map((g) => g.grade).sort()).toEqual([1, 2, 3]);
  });

  it("gradeName は『N年』、className は設置単位のラベルで PII を含まない", () => {
    for (const g of GINAN_GRADES) {
      expect(g.gradeName).toBe(`${g.grade}年`);
      expect(g.className.length).toBeGreaterThan(0);
      expect(g.className.length).toBeLessThanOrEqual(64);
      expect(`${g.gradeName}${g.className}`).not.toMatch(/\d{3,}/);
    }
  });
});

describe("validateGinanSchoolSeed", () => {
  it("既定シードは妥当（throw しない）", () => {
    expect(() => validateGinanSchoolSeed()).not.toThrow();
  });

  it("学年重複は throw", () => {
    const dup: GinanGradeSeed[] = [
      { grade: 1, gradeName: "1年", className: "A組" },
      { grade: 1, gradeName: "1年b", className: "B組" },
    ];
    expect(() => validateGinanSchoolSeed(dup)).toThrow();
  });

  it("空配列は throw", () => {
    expect(() => validateGinanSchoolSeed([])).toThrow();
  });

  it("クラス名空は throw", () => {
    const bad: GinanGradeSeed[] = [{ grade: 1, gradeName: "1年", className: "" }];
    expect(() => validateGinanSchoolSeed(bad)).toThrow();
  });
});
