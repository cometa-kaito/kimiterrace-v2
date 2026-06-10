import { describe, expect, it } from "vitest";
import { validateVisitorItems } from "../../lib/editor/visitors-core";

/**
 * パターン2「来校者一覧」編集の純粋検証ロジックの単体テスト（postgres / 認可に依存しない）。
 * 氏名必須・HH:MM 検証・長さ上限・空欄→null 正規化・件数上限を確認する。
 */
describe("validateVisitorItems", () => {
  it("正常: 氏名 + 任意項目を正規化（trim・空欄は null）", () => {
    const r = validateVisitorItems([
      {
        visitorName: " 佐藤 ",
        affiliation: "ABC商事",
        scheduledTime: "10:30",
        purpose: "面談",
        host: "田中",
        note: "",
      },
      { visitorName: "鈴木" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        {
          visitorName: "佐藤",
          affiliation: "ABC商事",
          scheduledTime: "10:30",
          purpose: "面談",
          host: "田中",
          note: null,
        },
        {
          visitorName: "鈴木",
          affiliation: null,
          scheduledTime: null,
          purpose: null,
          host: null,
          note: null,
        },
      ],
    });
  });

  it("氏名は必須（空・欠落は拒否）", () => {
    expect(validateVisitorItems([{ visitorName: "  " }]).ok).toBe(false);
    expect(validateVisitorItems([{ affiliation: "X" }]).ok).toBe(false);
  });

  it("時刻は HH:MM（00:00〜23:59）のみ、空は許容", () => {
    expect(validateVisitorItems([{ visitorName: "A", scheduledTime: "10:30" }]).ok).toBe(true);
    expect(validateVisitorItems([{ visitorName: "A", scheduledTime: "00:00" }]).ok).toBe(true);
    expect(validateVisitorItems([{ visitorName: "A", scheduledTime: "23:59" }]).ok).toBe(true);
    expect(validateVisitorItems([{ visitorName: "A", scheduledTime: "" }]).ok).toBe(true);
    expect(validateVisitorItems([{ visitorName: "A", scheduledTime: "9:5" }]).ok).toBe(false);
    expect(validateVisitorItems([{ visitorName: "A", scheduledTime: "25:00" }]).ok).toBe(false);
    expect(validateVisitorItems([{ visitorName: "A", scheduledTime: "10:60" }]).ok).toBe(false);
  });

  it("長さ上限（氏名 101 / 用件 201）は拒否", () => {
    expect(validateVisitorItems([{ visitorName: "あ".repeat(101) }]).ok).toBe(false);
    expect(validateVisitorItems([{ visitorName: "A", purpose: "x".repeat(201) }]).ok).toBe(false);
    expect(validateVisitorItems([{ visitorName: "あ".repeat(100) }]).ok).toBe(true); // 境界
  });

  it("配列でない / 51 名超は拒否、空配列は許可", () => {
    expect(validateVisitorItems({}).ok).toBe(false);
    expect(validateVisitorItems(null).ok).toBe(false);
    expect(validateVisitorItems([])).toEqual({ ok: true, value: [] });
    const many = Array.from({ length: 51 }, () => ({ visitorName: "A" }));
    expect(validateVisitorItems(many).ok).toBe(false);
  });
});
