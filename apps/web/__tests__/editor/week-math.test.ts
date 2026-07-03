import { describe, expect, it } from "vitest";

/**
 * 前週コピー（C2）の週演算 `week-math` の単体テスト。UTC 演算で週境界（月曜始まり）と月〜金の日割りを
 * 決定的に固定する。暦アンカー: 2026-06-01 は月曜（signage-rotation.test の 06-08 月と整合）。
 */

import { addDaysUtc, businessWeek, mondayOfWeek } from "../../lib/editor/week-math";

describe("week-math", () => {
  it("addDaysUtc は日付を前後に動かす（月跨ぎ・不正は空）", () => {
    expect(addDaysUtc("2026-06-05", 1)).toBe("2026-06-06");
    expect(addDaysUtc("2026-06-01", -1)).toBe("2026-05-31");
    expect(addDaysUtc("2026-06-08", -7)).toBe("2026-06-01");
    expect(addDaysUtc("bad", 1)).toBe("");
  });

  it("mondayOfWeek は週の月曜（月曜始まり。2026-06-01 が月曜）", () => {
    expect(mondayOfWeek("2026-06-01")).toBe("2026-06-01"); // 月
    expect(mondayOfWeek("2026-06-05")).toBe("2026-06-01"); // 金 → 同週月曜
    expect(mondayOfWeek("2026-06-07")).toBe("2026-06-01"); // 日 → 同週月曜
    expect(mondayOfWeek("2026-06-08")).toBe("2026-06-08"); // 翌週月
  });

  it("businessWeek は月曜から月〜金の 5 日", () => {
    expect(businessWeek("2026-06-01")).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ]);
  });

  it("mondayOfWeek + addDaysUtc(-7) で前週月曜（年跨ぎ・月跨ぎも UTC 暦日で正しい）", () => {
    expect(addDaysUtc(mondayOfWeek("2026-06-03"), -7)).toBe("2026-05-25"); // 月跨ぎ
    expect(addDaysUtc(mondayOfWeek("2026-01-01"), -7)).toBe("2025-12-22"); // 年跨ぎ（2026-01-01 は木）
  });
});
