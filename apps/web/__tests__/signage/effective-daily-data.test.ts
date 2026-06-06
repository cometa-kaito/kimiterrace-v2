import { describe, expect, it } from "vitest";
import { type DailyScopeRow, mergeDailySections } from "../../lib/signage/effective-daily-data";

/**
 * daily_data 階層マージ (class > grade > school、per-field) の純粋ロジック検証 (#48-E1)。
 */

function row(scope: DailyScopeRow["scope"], parts: Partial<DailyScopeRow>): DailyScopeRow {
  return {
    scope,
    schedules: parts.schedules ?? [],
    notices: parts.notices ?? [],
    assignments: parts.assignments ?? [],
    quietHours: parts.quietHours ?? [],
  };
}

describe("mergeDailySections", () => {
  it("各セクションで最も具体的な非空 scope を採用 (class > grade > school)", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("school", { schedules: ["S校"], notices: ["N校"], assignments: ["A校"] }),
      row("grade", { notices: ["N学年"] }),
      row("class", { schedules: ["S組"] }),
    ]);
    // schedules: class が非空 → class
    expect(merged.schedules).toEqual({ items: ["S組"], source: "class" });
    // notices: class 空 / grade 非空 → grade
    expect(merged.notices).toEqual({ items: ["N学年"], source: "grade" });
    // assignments: class/grade 空 / school 非空 → school
    expect(merged.assignments).toEqual({ items: ["A校"], source: "school" });
    // quietHours: 全空 → source null
    expect(merged.quietHours).toEqual({ items: [], source: null });
  });

  it("date はそのまま透過", () => {
    expect(mergeDailySections("2026-01-09", []).date).toBe("2026-01-09");
  });

  it("空配列・非配列は「無し」として扱い下位 scope にフォールバック", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("class", { schedules: [] }), // 空 → スキップ
      row("school", { schedules: ["S校"] }),
    ]);
    expect(merged.schedules).toEqual({ items: ["S校"], source: "school" });
  });

  it("該当 scope 行が無くても安全 (全セクション空)", () => {
    const merged = mergeDailySections("2026-05-30", []);
    for (const sec of [merged.schedules, merged.notices, merged.assignments, merged.quietHours]) {
      expect(sec).toEqual({ items: [], source: null });
    }
  });

  it("department scope は school より優先 / grade より下 (段A-2: class > grade > department > school)", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("school", { schedules: ["S校"], notices: ["N校"], assignments: ["A校"] }),
      row("department", { schedules: ["S学科"], notices: ["N学科"] }),
      row("grade", { schedules: ["S学年"] }),
    ]);
    // schedules: grade 非空 → grade (department/school より優先)
    expect(merged.schedules).toEqual({ items: ["S学年"], source: "grade" });
    // notices: grade 空 / department 非空 → department (school より優先)
    expect(merged.notices).toEqual({ items: ["N学科"], source: "department" });
    // assignments: grade/department 空 / school 非空 → school
    expect(merged.assignments).toEqual({ items: ["A校"], source: "school" });
  });

  it("department のみ非空なら department を採用 (学科全体編集がサイネージに反映される)", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("department", { schedules: ["S学科"] }),
      row("school", { schedules: [] }),
    ]);
    expect(merged.schedules).toEqual({ items: ["S学科"], source: "department" });
  });

  it("class > grade > department > school の完全な優先順", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("class", { schedules: ["S組"] }),
      row("grade", { schedules: ["S学年"] }),
      row("department", { schedules: ["S学科"] }),
      row("school", { schedules: ["S校"] }),
    ]);
    expect(merged.schedules).toEqual({ items: ["S組"], source: "class" });
  });

  it("class スコープ採用時は source=class (継承バッジを出さない側)", () => {
    const merged = mergeDailySections("2026-05-30", [row("class", { notices: ["緊急"] })]);
    expect(merged.notices.source).toBe("class");
  });
});

/**
 * 静粛時間 (quiet_hours) の二段フォールバック (#191、#48-J-2 配線)。
 * 優先順: 当日 daily_data の override (階層マージ結果) > school_configs クラス既定 (永続)。
 * `quietHoursFallback` は school_configs `{ ranges }` から取り出した配列 (値形ブリッジ済) を渡す。
 */
describe("mergeDailySections: quiet_hours 二段フォールバック (#191)", () => {
  const dailyRange = [{ start: "08:00", end: "08:30" }];
  const configRange = [{ start: "12:00", end: "13:00" }];

  it("daily_data に quiet_hours override があれば既定より優先 (override > default)", () => {
    const merged = mergeDailySections(
      "2026-05-31",
      [row("class", { quietHours: dailyRange })],
      configRange,
    );
    expect(merged.quietHours).toEqual({ items: dailyRange, source: "class" });
  });

  it("daily_data に無く school_configs クラス既定があればそれを採用 (default、source=class)", () => {
    const merged = mergeDailySections("2026-05-31", [], configRange);
    expect(merged.quietHours).toEqual({ items: configRange, source: "class" });
  });

  it("daily_data の quiet_hours が空配列でも既定にフォールバックする", () => {
    const merged = mergeDailySections(
      "2026-05-31",
      [row("class", { quietHours: [] })],
      configRange,
    );
    expect(merged.quietHours).toEqual({ items: configRange, source: "class" });
  });

  it("両方なし (既定 null) → 空 source null", () => {
    const merged = mergeDailySections("2026-05-31", [], null);
    expect(merged.quietHours).toEqual({ items: [], source: null });
  });

  it("既定が空配列のときも空 source null (空既定はフォールバックしない)", () => {
    const merged = mergeDailySections("2026-05-31", [], []);
    expect(merged.quietHours).toEqual({ items: [], source: null });
  });

  it("既定は他セクション (schedules/notices/assignments) には影響しない", () => {
    const merged = mergeDailySections(
      "2026-05-31",
      [row("school", { schedules: ["S校"] })],
      configRange,
    );
    expect(merged.schedules).toEqual({ items: ["S校"], source: "school" });
    expect(merged.notices).toEqual({ items: [], source: null });
    expect(merged.assignments).toEqual({ items: [], source: null });
    // quiet_hours だけ既定が効く
    expect(merged.quietHours).toEqual({ items: configRange, source: "class" });
  });

  it("daily_data grade/school scope に quiet_hours があれば既定より優先 (override は scope を問わない)", () => {
    const gradeRange = [{ start: "15:00", end: "16:00" }];
    const merged = mergeDailySections(
      "2026-05-31",
      [row("grade", { quietHours: gradeRange })],
      configRange,
    );
    // grade の override が既定より優先。source は採用 scope (grade)。
    expect(merged.quietHours).toEqual({ items: gradeRange, source: "grade" });
  });

  it("既定引数を省略すると従来挙動 (空 source null)", () => {
    const merged = mergeDailySections("2026-05-31", []);
    expect(merged.quietHours).toEqual({ items: [], source: null });
  });
});
