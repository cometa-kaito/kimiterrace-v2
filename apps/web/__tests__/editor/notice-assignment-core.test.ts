import { describe, expect, it } from "vitest";
import {
  validateAssignmentItems,
  validateNoticeItems,
} from "../../lib/editor/notice-assignment-core";

describe("validateNoticeItems", () => {
  it("正常: 入力順を保持 + text を trim、isHighlight は true のみ採用", () => {
    const r = validateNoticeItems([
      { text: "  体育館に集合  " },
      { text: "プリント配布", isHighlight: true },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [{ text: "体育館に集合" }, { text: "プリント配布", isHighlight: true }],
    });
  });

  it("isHighlight が true 以外 (truthy 文字列含む) は無視 (キーを付けない)", () => {
    const r = validateNoticeItems([{ text: "x", isHighlight: "true" }]);
    expect(r.ok && r.value[0]).toEqual({ text: "x" });
  });

  it("配列でない入力は拒否", () => {
    expect(validateNoticeItems({}).ok).toBe(false);
    expect(validateNoticeItems(null).ok).toBe(false);
  });

  it("空 text・空白のみは拒否", () => {
    expect(validateNoticeItems([{ text: "" }]).ok).toBe(false);
    expect(validateNoticeItems([{ text: "   " }]).ok).toBe(false);
  });

  it("text 501 文字は拒否 (境界 500 は許可)", () => {
    expect(validateNoticeItems([{ text: "あ".repeat(500) }]).ok).toBe(true);
    expect(validateNoticeItems([{ text: "あ".repeat(501) }]).ok).toBe(false);
  });

  it("21 件超は拒否 (境界 20 は許可)", () => {
    const ok = Array.from({ length: 20 }, () => ({ text: "x" }));
    const ng = Array.from({ length: 21 }, () => ({ text: "x" }));
    expect(validateNoticeItems(ok).ok).toBe(true);
    expect(validateNoticeItems(ng).ok).toBe(false);
  });

  it("オブジェクト以外の要素は拒否", () => {
    expect(validateNoticeItems(["just a string"]).ok).toBe(false);
    expect(validateNoticeItems([null]).ok).toBe(false);
  });

  it("空配列は許可 (連絡なし = 全削除)", () => {
    expect(validateNoticeItems([])).toEqual({ ok: true, value: [] });
  });

  it("displayDays: >1 は採用、1 / 未指定 は省略 (既定 今日のみ)", () => {
    expect(validateNoticeItems([{ text: "a", displayDays: 3 }])).toEqual({
      ok: true,
      value: [{ text: "a", displayDays: 3 }],
    });
    expect(validateNoticeItems([{ text: "a", displayDays: 1 }])).toEqual({
      ok: true,
      value: [{ text: "a" }],
    });
    expect(validateNoticeItems([{ text: "a" }])).toEqual({ ok: true, value: [{ text: "a" }] });
  });

  it("displayDays: 0 / 15 / 非整数 / 文字列 は拒否 (境界 14 は許可)", () => {
    expect(validateNoticeItems([{ text: "a", displayDays: 14 }]).ok).toBe(true);
    expect(validateNoticeItems([{ text: "a", displayDays: 0 }]).ok).toBe(false);
    expect(validateNoticeItems([{ text: "a", displayDays: 15 }]).ok).toBe(false);
    expect(validateNoticeItems([{ text: "a", displayDays: 2.5 }]).ok).toBe(false);
    expect(validateNoticeItems([{ text: "a", displayDays: "3" }]).ok).toBe(false);
  });
});

describe("validateAssignmentItems", () => {
  it("正常: 期限の昇順に正規化 + subject/task を trim", () => {
    const r = validateAssignmentItems([
      { deadline: "2026-06-10", subject: " 数学 ", task: " ワーク p.10 " },
      { deadline: "2026-06-05", subject: "国語", task: "漢字テスト" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { deadline: "2026-06-05", subject: "国語", task: "漢字テスト" },
        { deadline: "2026-06-10", subject: "数学", task: "ワーク p.10" },
      ],
    });
  });

  it("配列でない入力は拒否", () => {
    expect(validateAssignmentItems({}).ok).toBe(false);
    expect(validateAssignmentItems(null).ok).toBe(false);
  });

  it("実在しない / 形式不正な deadline は拒否", () => {
    expect(validateAssignmentItems([{ deadline: "2026-02-30", subject: "x", task: "y" }]).ok).toBe(
      false,
    );
    expect(validateAssignmentItems([{ deadline: "2026/06/01", subject: "x", task: "y" }]).ok).toBe(
      false,
    );
    expect(validateAssignmentItems([{ subject: "x", task: "y" }]).ok).toBe(false);
  });

  it("空 subject / 空 task は拒否", () => {
    expect(validateAssignmentItems([{ deadline: "2026-06-01", subject: "  ", task: "y" }]).ok).toBe(
      false,
    );
    expect(validateAssignmentItems([{ deadline: "2026-06-01", subject: "x", task: "" }]).ok).toBe(
      false,
    );
  });

  it("subject 33 文字 / task 201 文字は拒否 (境界 32 / 200 は許可)", () => {
    const base = { deadline: "2026-06-01" };
    expect(
      validateAssignmentItems([{ ...base, subject: "あ".repeat(32), task: "い".repeat(200) }]).ok,
    ).toBe(true);
    expect(validateAssignmentItems([{ ...base, subject: "あ".repeat(33), task: "y" }]).ok).toBe(
      false,
    );
    expect(validateAssignmentItems([{ ...base, subject: "x", task: "い".repeat(201) }]).ok).toBe(
      false,
    );
  });

  it("31 件超は拒否 (境界 30 は許可)", () => {
    const item = { deadline: "2026-06-01", subject: "x", task: "y" };
    expect(validateAssignmentItems(Array.from({ length: 30 }, () => item)).ok).toBe(true);
    expect(validateAssignmentItems(Array.from({ length: 31 }, () => item)).ok).toBe(false);
  });

  it("空配列は許可 (提出物なし = 全削除)", () => {
    expect(validateAssignmentItems([])).toEqual({ ok: true, value: [] });
  });
});
