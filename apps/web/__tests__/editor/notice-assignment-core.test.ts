import { describe, expect, it } from "vitest";
import {
  copyableNoticeItems,
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

// ===================== PR-B 自由度基本セット（区切り線 / ★重要） =====================

describe("validateNoticeItems: 区切り線（kind:'divider'・§5.3）", () => {
  it("divider を受理し text を任意ラベル（trim・空可）として保存する", () => {
    expect(validateNoticeItems([{ kind: "divider", text: " 校訓 " }])).toEqual({
      ok: true,
      value: [{ kind: "divider", text: "校訓" }],
    });
    expect(validateNoticeItems([{ kind: "divider" }])).toEqual({
      ok: true,
      value: [{ kind: "divider", text: "" }],
    });
  });

  it("divider は displayDays を通常行と同じライフサイクルで保持し、isHighlight のみ剥がす（§5.3 MEDIUM-1）", () => {
    // 「区切り線も通常の連絡行と同じライフサイクルを持つ」＝本文が罫線であるだけの行。displayDays を
    // 剥がすと多日連絡のグルーピング（校訓掲示板等）が翌日崩れる。isHighlight は罫線に概念なし＝剥がす。
    const r = validateNoticeItems([
      { kind: "divider", text: "校訓", isHighlight: true, displayDays: 7 },
    ]);
    expect(r).toEqual({ ok: true, value: [{ kind: "divider", text: "校訓", displayDays: 7 }] });
  });

  it("divider の displayDays も通常行と同じ規則（既定 1 は省略・1..14 の整数のみ・不正は全体拒否）", () => {
    // 既定 1（今日のみ）は省略して保存（JSONB 最小化・通常行と同一規則）。
    expect(validateNoticeItems([{ kind: "divider", text: "校訓", displayDays: 1 }])).toEqual({
      ok: true,
      value: [{ kind: "divider", text: "校訓" }],
    });
    // 境界 14 は許可・15 / 0 / 非整数は拒否（通常行と同一メッセージ経路）。
    expect(validateNoticeItems([{ kind: "divider", text: "", displayDays: 14 }])).toEqual({
      ok: true,
      value: [{ kind: "divider", text: "", displayDays: 14 }],
    });
    expect(validateNoticeItems([{ kind: "divider", text: "", displayDays: 15 }]).ok).toBe(false);
    expect(validateNoticeItems([{ kind: "divider", text: "", displayDays: 0 }]).ok).toBe(false);
    expect(validateNoticeItems([{ kind: "divider", text: "", displayDays: 1.5 }]).ok).toBe(false);
  });

  it("未知の kind 値は拒否（黙って通さない）", () => {
    expect(validateNoticeItems([{ kind: "header", text: "x" }]).ok).toBe(false);
  });

  it("divider ラベル 33 文字は拒否（境界 32 は許可・DIVIDER_LABEL_MAX）", () => {
    expect(validateNoticeItems([{ kind: "divider", text: "あ".repeat(32) }]).ok).toBe(true);
    expect(validateNoticeItems([{ kind: "divider", text: "あ".repeat(33) }]).ok).toBe(false);
  });

  it("divider を挟んでも入力順を保持する（連絡は配列順＝盤面順）", () => {
    const r = validateNoticeItems([
      { text: "連絡A" },
      { kind: "divider", text: "" },
      { text: "連絡B", isHighlight: true },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { text: "連絡A" },
        { kind: "divider", text: "" },
        { text: "連絡B", isHighlight: true },
      ],
    });
  });
});

// ===================== PR-C 固定行（pinned・「ずっと」・§5.4） =====================

describe("validateNoticeItems: 固定表示（pinned・§5.4）", () => {
  it("pinned は明示 true のみ受理（isHighlight と同作法・truthy 文字列は無視）", () => {
    expect(validateNoticeItems([{ text: "校訓", pinned: true }])).toEqual({
      ok: true,
      value: [{ text: "校訓", pinned: true }],
    });
    expect(validateNoticeItems([{ text: "x", pinned: "true" }])).toEqual({
      ok: true,
      value: [{ text: "x" }],
    });
    expect(validateNoticeItems([{ text: "x", pinned: false }])).toEqual({
      ok: true,
      value: [{ text: "x" }],
    });
  });

  it("pinned のとき displayDays は保存しない（排他・「ずっと」は期間ではなく固定という別概念）", () => {
    expect(validateNoticeItems([{ text: "校訓", pinned: true, displayDays: 7 }])).toEqual({
      ok: true,
      value: [{ text: "校訓", pinned: true }],
    });
  });

  it("pinned でも不正な displayDays は拒否（黙って通さない・1 件不正なら全体拒否）", () => {
    expect(validateNoticeItems([{ text: "x", pinned: true, displayDays: 99 }]).ok).toBe(false);
    expect(validateNoticeItems([{ text: "x", pinned: true, displayDays: "7" }]).ok).toBe(false);
  });

  it("pinned と isHighlight は両立する（固定かつ重要）", () => {
    expect(validateNoticeItems([{ text: "避難経路", pinned: true, isHighlight: true }])).toEqual({
      ok: true,
      value: [{ text: "避難経路", pinned: true, isHighlight: true }],
    });
  });

  it("divider にも pinned を許可（「区切り線ごと固定」＝校訓掲示板・isHighlight のみ剥がす）", () => {
    const r = validateNoticeItems([
      { kind: "divider", text: "校訓", pinned: true, displayDays: 7, isHighlight: true },
    ]);
    expect(r).toEqual({ ok: true, value: [{ kind: "divider", text: "校訓", pinned: true }] });
  });

  it("後方互換: pinned を持たない既存 JSONB（text/isHighlight/displayDays/divider）は従来どおり通る", () => {
    const legacy = [
      { text: "通常" },
      { text: "重要", isHighlight: true },
      { text: "三日間", displayDays: 3 },
      { kind: "divider", text: "", displayDays: 14 },
    ];
    expect(validateNoticeItems(legacy)).toEqual({ ok: true, value: legacy });
  });
});

describe("validateNoticeItems: allowPinned=false（scope≠class の保存経路・HIGH-1 防御の二層目）", () => {
  it("pinned を黙って剥がし、displayDays があればそれを生かす（拒否しない・fail-soft）", () => {
    const r = validateNoticeItems(
      [
        { text: "固定のつもり", pinned: true, displayDays: 7 },
        { text: "固定のみ", pinned: true },
        { kind: "divider", text: "校訓", pinned: true },
      ],
      { allowPinned: false },
    );
    expect(r).toEqual({
      ok: true,
      value: [
        { text: "固定のつもり", displayDays: 7 },
        { text: "固定のみ" }, // 既定 1（入力日のみ）へ劣化
        { kind: "divider", text: "校訓" },
      ],
    });
  });

  it("allowPinned=false でも不正な displayDays は従来どおり拒否（黙って通さない）", () => {
    expect(
      validateNoticeItems([{ text: "x", pinned: true, displayDays: 15 }], { allowPinned: false })
        .ok,
    ).toBe(false);
  });

  it("allowPinned 省略/true は従来どおり pinned を受理（後方互換・クラス保存経路）", () => {
    expect(validateNoticeItems([{ text: "校訓", pinned: true }])).toEqual({
      ok: true,
      value: [{ text: "校訓", pinned: true }],
    });
    expect(validateNoticeItems([{ text: "校訓", pinned: true }], { allowPinned: true })).toEqual({
      ok: true,
      value: [{ text: "校訓", pinned: true }],
    });
  });
});

describe("copyableNoticeItems（前日/前週コピーの複製対象・§6.4）", () => {
  it("pinned（通常行・divider とも）を除外し、通常行と divider は残す（入力順保持）", () => {
    expect(
      copyableNoticeItems([
        { text: "通常" },
        { text: "校訓", pinned: true },
        { kind: "divider", text: "" },
        { kind: "divider", text: "校訓", pinned: true },
        { text: "三日間", displayDays: 3 },
      ]),
    ).toEqual([
      { text: "通常" },
      { kind: "divider", text: "" },
      { text: "三日間", displayDays: 3 },
    ]);
  });

  it("pinned が無ければ全件そのまま（従来コピーの回帰なし）", () => {
    const items = [{ text: "a" }, { text: "b", isHighlight: true }];
    expect(copyableNoticeItems(items)).toEqual(items);
  });
});

describe("validateAssignmentItems: ★重要（isHighlight・§5.2）", () => {
  it("isHighlight は明示 true のみ採用（連絡と同作法・期限昇順ソート後も保持）", () => {
    const r = validateAssignmentItems([
      { deadline: "2026-06-20", subject: "国語", task: "音読", isHighlight: true },
      { deadline: "2026-06-18", subject: "数学", task: "P30", isHighlight: "true" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { deadline: "2026-06-18", subject: "数学", task: "P30" },
        { deadline: "2026-06-20", subject: "国語", task: "音読", isHighlight: true },
      ],
    });
  });
});
