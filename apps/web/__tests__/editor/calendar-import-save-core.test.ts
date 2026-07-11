import { describe, expect, it } from "vitest";
import { MAX_FILE_IMPORT_EVENTS, fiscalYearWindow } from "../../lib/editor/calendar-import-core";
import { validateCalendarImportSave } from "../../lib/editor/calendar-import-save-core";

/**
 * ADR-049 PR-C: 保存前再検証の純ロジック（calendar-import-save-core）。プレビューで教員が編集した配列は
 * 信用しない = スキーマ・実在暦日・年度窓・重複・上限を再強制し、**drop せず**行番号付きエラーで返す。
 */

// 2026-05-01 JST → 年度 2026（2026-04-01〜2027-03-31）。
const WINDOW = fiscalYearWindow(Date.UTC(2026, 4, 1));

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { summary: "体育祭", startDate: "2026-05-20", allDay: true, ...overrides };
}

describe("validateCalendarImportSave", () => {
  it("正常な行は events として返す（空 endDate/location は省略に正規化）", () => {
    const r = validateCalendarImportSave(
      [
        row(),
        row({
          summary: "修学旅行",
          startDate: "2026-10-05",
          endDate: "2026-10-08",
          location: "沖縄",
        }),
        row({ summary: "終業式", startDate: "2026-07-20", endDate: "", location: "" }),
      ],
      WINDOW,
    );
    expect(r).toEqual({
      ok: true,
      events: [
        {
          summary: "体育祭",
          startDate: "2026-05-20",
          allDay: true,
          endDate: undefined,
          location: undefined,
        },
        {
          summary: "修学旅行",
          startDate: "2026-10-05",
          endDate: "2026-10-08",
          allDay: true,
          location: "沖縄",
        },
        {
          summary: "終業式",
          startDate: "2026-07-20",
          allDay: true,
          endDate: undefined,
          location: undefined,
        },
      ],
    });
  });

  it("配列以外は全体エラー（index -1）", () => {
    const r = validateCalendarImportSave({ events: [] }, WINDOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toEqual([{ index: -1, message: "保存データの形式が不正です。" }]);
    }
  });

  it("空配列は拒否（前回取込の全消しを本 UI から起こさない）", () => {
    const r = validateCalendarImportSave([], WINDOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]?.index).toBe(-1);
      expect(r.issues[0]?.message).toContain("保存する行事がありません");
    }
  });

  it("上限超過は全体エラー", () => {
    const rows = Array.from({ length: MAX_FILE_IMPORT_EVENTS + 1 }, (_, i) =>
      row({ summary: `行事${i}` }),
    );
    const r = validateCalendarImportSave(rows, WINDOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]?.message).toContain(`上限 ${MAX_FILE_IMPORT_EVENTS} 件`);
    }
  });

  it("スキーマ不適合はフィールド別の行エラー（drop しない）", () => {
    const r = validateCalendarImportSave(
      [row({ summary: "" }), row({ startDate: "5/20" }), row({ location: "x".repeat(101) })],
      WINDOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(3);
      expect(r.issues[0]).toMatchObject({ index: 0 });
      expect(r.issues[0]?.message).toContain("行事名");
      expect(r.issues[1]?.message).toContain("開始日");
      expect(r.issues[2]?.message).toContain("場所");
    }
  });

  it("非実在暦日・年度窓外の開始日は行エラー", () => {
    const r = validateCalendarImportSave(
      [row({ startDate: "2026-02-30" }), row({ startDate: "2026-03-31" })],
      WINDOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]?.message).toContain("実在しない");
      expect(r.issues[1]?.message).toContain("対象年度");
    }
  });

  it("終了日が開始日より前 / 年度末超え / 非実在は行エラー", () => {
    const r = validateCalendarImportSave(
      [
        row({ endDate: "2026-05-19" }),
        row({ summary: "卒業式", startDate: "2027-03-01", endDate: "2027-04-01" }),
        row({ summary: "考査", endDate: "2026-06-31" }),
      ],
      WINDOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(3);
      for (const issue of r.issues) {
        expect(issue.message).toContain("終了日");
      }
    }
  });

  it("同一 (summary, startDate) の重複は後の行をエラーにする", () => {
    const r = validateCalendarImportSave([row(), row({ location: "グラウンド" })], WINDOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toEqual([{ index: 1, message: "同じ行事名・開始日の行が重複しています。" }]);
    }
  });
});
