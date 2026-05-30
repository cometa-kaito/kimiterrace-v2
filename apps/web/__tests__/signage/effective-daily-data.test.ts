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

  it("department scope は表示対象外として無視される", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("department", { schedules: ["S学科"] }),
      row("school", { schedules: ["S校"] }),
    ]);
    // department は拾わず school にフォールバック
    expect(merged.schedules).toEqual({ items: ["S校"], source: "school" });
  });

  it("class スコープ採用時は source=class (継承バッジを出さない側)", () => {
    const merged = mergeDailySections("2026-05-30", [row("class", { notices: ["緊急"] })]);
    expect(merged.notices.source).toBe("class");
  });
});
