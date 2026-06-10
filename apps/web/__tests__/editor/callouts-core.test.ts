import { describe, expect, it } from "vitest";
import { validateCalloutItems } from "../../lib/editor/callouts-core";

/**
 * パターン2「生徒呼び出し」編集の純粋検証ロジックの単体テスト（postgres / 認可に依存しない）。
 * 氏名必須・HH:MM 検証・長さ上限・空欄→null 正規化・件数上限を確認する。
 */
describe("validateCalloutItems", () => {
  it("正常: 氏名 + 任意項目を正規化（trim・空欄は null）", () => {
    const r = validateCalloutItems([
      { studentName: " 佐藤太郎 ", location: "職員室", reason: "忘れ物", scheduledTime: "10:15" },
      { studentName: "鈴木花子" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { studentName: "佐藤太郎", location: "職員室", reason: "忘れ物", scheduledTime: "10:15" },
        { studentName: "鈴木花子", location: null, reason: null, scheduledTime: null },
      ],
    });
  });

  it("氏名は必須（空・欠落は拒否）", () => {
    expect(validateCalloutItems([{ studentName: "  " }]).ok).toBe(false);
    expect(validateCalloutItems([{ location: "職員室" }]).ok).toBe(false);
  });

  it("時刻は HH:MM（00:00〜23:59）のみ、空は許容", () => {
    expect(validateCalloutItems([{ studentName: "A", scheduledTime: "23:59" }]).ok).toBe(true);
    expect(validateCalloutItems([{ studentName: "A", scheduledTime: "" }]).ok).toBe(true);
    expect(validateCalloutItems([{ studentName: "A", scheduledTime: "9:5" }]).ok).toBe(false);
    expect(validateCalloutItems([{ studentName: "A", scheduledTime: "24:00" }]).ok).toBe(false);
  });

  it("長さ上限（氏名 101 / 用件 201）は拒否、境界は許容", () => {
    expect(validateCalloutItems([{ studentName: "あ".repeat(101) }]).ok).toBe(false);
    expect(validateCalloutItems([{ studentName: "A", reason: "x".repeat(201) }]).ok).toBe(false);
    expect(validateCalloutItems([{ studentName: "あ".repeat(100) }]).ok).toBe(true);
  });

  it("配列でない / 51 件超は拒否、空配列は許可", () => {
    expect(validateCalloutItems({}).ok).toBe(false);
    expect(validateCalloutItems([])).toEqual({ ok: true, value: [] });
    const many = Array.from({ length: 51 }, () => ({ studentName: "A" }));
    expect(validateCalloutItems(many).ok).toBe(false);
  });
});
