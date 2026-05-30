import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../lib/auth/session";
import { isValidDate, toEditorActor, validateScheduleItems } from "../../lib/editor/schedule-core";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("isValidDate", () => {
  it("実在する YYYY-MM-DD は true", () => {
    expect(isValidDate("2026-05-31")).toBe(true);
  });
  it("形式不正・実在しない日は false", () => {
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026/05/31")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });
});

describe("toEditorActor", () => {
  it("school_id があれば actor", () => {
    const u: AuthUser = { uid: "u1", role: "teacher", schoolId: UUID };
    expect(toEditorActor(u)).toEqual({ userId: "u1", schoolId: UUID });
  });
  it("school_id null は null", () => {
    expect(toEditorActor({ uid: "u1", role: "system_admin", schoolId: null })).toBeNull();
  });
});

describe("validateScheduleItems", () => {
  it("正常: period 昇順に正規化 + note 任意", () => {
    const r = validateScheduleItems([
      { period: 2, subject: " 数学 " },
      { period: 1, subject: "国語", note: "教室変更" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { period: 1, subject: "国語", note: "教室変更" },
        { period: 2, subject: "数学" },
      ],
    });
  });

  it("文字列 period も受理", () => {
    const r = validateScheduleItems([{ period: "3", subject: "理科" }]);
    expect(r.ok && r.value[0]?.period).toBe(3);
  });

  it("配列でない入力は拒否", () => {
    expect(validateScheduleItems({}).ok).toBe(false);
    expect(validateScheduleItems(null).ok).toBe(false);
  });

  it("空科目は拒否", () => {
    expect(validateScheduleItems([{ period: 1, subject: "  " }]).ok).toBe(false);
  });

  it("時限の範囲外は拒否 (1..12)", () => {
    expect(validateScheduleItems([{ period: 0, subject: "x" }]).ok).toBe(false);
    expect(validateScheduleItems([{ period: 13, subject: "x" }]).ok).toBe(false);
  });

  it("時限の重複は拒否", () => {
    const r = validateScheduleItems([
      { period: 1, subject: "国語" },
      { period: 1, subject: "数学" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("13 コマ超は拒否", () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ period: i + 1, subject: "x" }));
    expect(validateScheduleItems(items).ok).toBe(false);
  });

  it("科目名 33 文字は拒否", () => {
    expect(validateScheduleItems([{ period: 1, subject: "あ".repeat(33) }]).ok).toBe(false);
  });

  it("空配列は許可 (時間割なし = 全削除)", () => {
    expect(validateScheduleItems([])).toEqual({ ok: true, value: [] });
  });
});
