import { describe, expect, it } from "vitest";
import {
  type AssistantDraft,
  CHAT_MESSAGE_MAX,
  MAX_CHAT_TURNS,
  MAX_DRAFT_DAYS,
  draftHasItems,
  draftItemCounts,
  filterDraftToSections,
  latestUserMessage,
  multiDayWrites,
  parseChatTurns,
  sanitizeDraft,
} from "../../lib/editor/assistant-chat-core";

/**
 * 会話型 AI アシスタント API 契約（assistant-chat-core）の純ヘルパ検証。DB/Vertex 非依存（ADR-012）。
 * parseChatTurns（role/長さ/末尾 user/件数上限）・sanitizeDraft（fail-soft 正規化）・
 * filterDraftToSections（パターン準拠の許可絞り）・件数ヘルパ。
 */

describe("parseChatTurns", () => {
  it("正常な履歴（末尾 user）を正規化する", () => {
    const turns = parseChatTurns([
      { role: "user", content: "明日の予定を作って" },
      { role: "assistant", content: "了解しました" },
      { role: "user", content: "1限を数学に" },
    ]);
    expect(turns).toEqual([
      { role: "user", content: "明日の予定を作って" },
      { role: "assistant", content: "了解しました" },
      { role: "user", content: "1限を数学に" },
    ]);
  });

  it("content の前後空白は trim する", () => {
    const turns = parseChatTurns([{ role: "user", content: "  こんにちは  " }]);
    expect(turns).toEqual([{ role: "user", content: "こんにちは" }]);
  });

  it("配列でない・空配列は null", () => {
    expect(parseChatTurns(null)).toBeNull();
    expect(parseChatTurns("x")).toBeNull();
    expect(parseChatTurns([])).toBeNull();
  });

  it("末尾が assistant の履歴は null（このターンの user 指示が無い）", () => {
    expect(
      parseChatTurns([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ]),
    ).toBeNull();
  });

  it("未知 role / content 非文字列 / 空 content / 過大 content は null", () => {
    expect(parseChatTurns([{ role: "system", content: "x" }])).toBeNull();
    expect(parseChatTurns([{ role: "user", content: 123 }])).toBeNull();
    expect(parseChatTurns([{ role: "user", content: "   " }])).toBeNull();
    expect(
      parseChatTurns([{ role: "user", content: "a".repeat(CHAT_MESSAGE_MAX + 1) }]),
    ).toBeNull();
  });

  it("MAX_CHAT_TURNS を超えると直近のみ残す（末尾 user は維持）", () => {
    const many = Array.from({ length: MAX_CHAT_TURNS + 6 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));
    // 末尾を user にそろえる（偶数 index=user なので最後の index が user になるよう調整）。
    many.push({ role: "user", content: "latest" });
    const turns = parseChatTurns(many);
    expect(turns).not.toBeNull();
    expect(turns?.length).toBe(MAX_CHAT_TURNS);
    expect(turns?.[turns.length - 1]).toEqual({ role: "user", content: "latest" });
  });
});

describe("latestUserMessage", () => {
  it("末尾 user の本文を返す", () => {
    expect(
      latestUserMessage([
        { role: "assistant", content: "x" },
        { role: "user", content: "最新の指示" },
      ]),
    ).toBe("最新の指示");
  });
  it("末尾が user でなければ null", () => {
    expect(latestUserMessage([{ role: "assistant", content: "x" }])).toBeNull();
    expect(latestUserMessage([])).toBeNull();
  });
});

describe("sanitizeDraft", () => {
  it("各セクションを検証済み型に正規化する", () => {
    const d = sanitizeDraft({
      schedules: [{ period: 2, subject: "数学" }],
      notices: [{ text: "全校集会", isHighlight: true }],
      assignments: [{ deadline: "2026-06-19", subject: "数学", task: "ワークP30" }],
    });
    expect(d.schedules).toEqual([{ period: 2, subject: "数学" }]);
    expect(d.notices).toEqual([{ text: "全校集会", isHighlight: true }]);
    expect(d.assignments).toEqual([{ deadline: "2026-06-19", subject: "数学", task: "ワークP30" }]);
  });

  it("不正/欠落セクションは空配列に倒す（fail-soft・他セクションは保持）", () => {
    const d = sanitizeDraft({
      schedules: [{ period: 99, subject: "x" }], // period 範囲外 → 不正 → []
      notices: [{ text: "残す" }],
      // assignments 欠落 → []
    });
    expect(d.schedules).toEqual([]);
    expect(d.notices).toEqual([{ text: "残す" }]);
    expect(d.assignments).toEqual([]);
  });

  it("object でない入力は空下書き", () => {
    expect(sanitizeDraft(null)).toEqual({ schedules: [], notices: [], assignments: [] });
    expect(sanitizeDraft([1, 2])).toEqual({ schedules: [], notices: [], assignments: [] });
  });
});

describe("filterDraftToSections", () => {
  const full: AssistantDraft = {
    schedules: [{ period: 1, subject: "数学" }],
    notices: [{ text: "連絡" }],
    assignments: [{ deadline: "2026-06-19", subject: "数学", task: "ワーク" }],
  };

  it("pattern2 相当（schedules のみ許可）= 連絡/提出物を落とす", () => {
    const d = filterDraftToSections(full, ["schedules"]);
    expect(d.schedules).toHaveLength(1);
    expect(d.notices).toEqual([]);
    expect(d.assignments).toEqual([]);
  });

  it("pattern1 相当（3 種許可）= すべて保持", () => {
    const d = filterDraftToSections(full, ["schedules", "notices", "assignments"]);
    expect(d).toEqual(full);
  });
});

describe("draftHasItems / draftItemCounts", () => {
  it("空下書きは false / 全 0（days 0 併記）", () => {
    const empty: AssistantDraft = { schedules: [], notices: [], assignments: [] };
    expect(draftHasItems(empty)).toBe(false);
    expect(draftItemCounts(empty)).toEqual({ schedules: 0, notices: 0, assignments: 0, days: 0 });
  });
  it("1 件でもあれば true / 件数を返す", () => {
    const d: AssistantDraft = {
      schedules: [{ period: 1, subject: "数学" }],
      notices: [],
      assignments: [{ deadline: "2026-06-19", subject: "数学", task: "ワーク" }],
    };
    expect(draftHasItems(d)).toBe(true);
    expect(draftItemCounts(d)).toEqual({ schedules: 1, notices: 0, assignments: 1, days: 0 });
  });
  it("top-level が空でも days があれば true / days 件数を返す", () => {
    const d: AssistantDraft = {
      schedules: [],
      notices: [],
      assignments: [],
      days: [
        {
          date: "2026-06-29",
          schedules: [{ period: 1, subject: "数学" }],
          notices: [],
          assignments: [],
        },
      ],
    };
    expect(draftHasItems(d)).toBe(true);
    expect(draftItemCounts(d)).toEqual({ schedules: 0, notices: 0, assignments: 0, days: 1 });
  });
});

describe("sanitizeDraft（複数日 days）", () => {
  it("実在日付の各日を 3 セクション検証して残す（単一日では days キーを生やさない）", () => {
    const single = sanitizeDraft({ schedules: [{ period: 1, subject: "数学" }] });
    expect("days" in single).toBe(false);

    const multi = sanitizeDraft({
      schedules: [],
      notices: [],
      assignments: [],
      days: [
        {
          date: "2026-06-29",
          schedules: [{ period: 1, subject: "数学" }],
          notices: [],
          assignments: [],
        },
        {
          date: "2026-06-30",
          schedules: [{ period: 1, subject: "実力テスト" }],
          notices: [{ text: "テスト範囲を確認" }],
          assignments: [],
        },
      ],
    });
    expect(multi.days).toEqual([
      {
        date: "2026-06-29",
        schedules: [{ period: 1, subject: "数学" }],
        notices: [],
        assignments: [],
      },
      {
        date: "2026-06-30",
        schedules: [{ period: 1, subject: "実力テスト" }],
        notices: [{ text: "テスト範囲を確認" }],
        assignments: [],
      },
    ]);
  });

  it("不正日付・空日・重複日付を落とし、不正セクションは fail-soft で空配列に倒す", () => {
    const d = sanitizeDraft({
      days: [
        { date: "2026-02-30", schedules: [{ period: 1, subject: "数学" }] }, // 実在しない日付 → 落とす
        { date: "not-a-date", schedules: [{ period: 1, subject: "数学" }] }, // 不正形式 → 落とす
        { date: "2026-06-29", schedules: [], notices: [], assignments: [] }, // 全空 → 落とす
        {
          date: "2026-07-01",
          schedules: [{ period: 99, subject: "x" }], // period 範囲外 → [] に倒す
          notices: [{ text: "残る連絡" }],
          assignments: [],
        },
        { date: "2026-07-01", schedules: [{ period: 2, subject: "国語" }] }, // 重複日付（先勝ち）→ 落とす
      ],
    });
    expect(d.days).toEqual([
      { date: "2026-07-01", schedules: [], notices: [{ text: "残る連絡" }], assignments: [] },
    ]);
  });

  it("MAX_DRAFT_DAYS を超える日数は切り捨てる", () => {
    const many = Array.from({ length: MAX_DRAFT_DAYS + 3 }, (_, i) => ({
      // 2026-07-01 から連番（すべて実在日付・1 件ずつ）。
      date: `2026-07-${String(i + 1).padStart(2, "0")}`,
      schedules: [{ period: 1, subject: "数学" }],
      notices: [],
      assignments: [],
    }));
    const d = sanitizeDraft({ days: many });
    expect(d.days).toHaveLength(MAX_DRAFT_DAYS);
  });
});

describe("filterDraftToSections / multiDayWrites（複数日 days）", () => {
  const multi: AssistantDraft = {
    schedules: [],
    notices: [],
    assignments: [],
    days: [
      {
        date: "2026-06-29",
        schedules: [{ period: 1, subject: "数学" }],
        notices: [{ text: "持ち物連絡" }],
        assignments: [],
      },
      { date: "2026-06-30", schedules: [], notices: [{ text: "連絡のみ" }], assignments: [] },
    ],
  };

  it("許可外セクションを各日から落とし、絞り後に空になった日は除外する（pattern2 = schedules のみ）", () => {
    const writes = multiDayWrites(multi, ["schedules"]);
    // 6/29 は schedules が残る。6/30 は notices のみ → schedules 絞りで空 → 落とす。
    expect(writes).toEqual([
      {
        date: "2026-06-29",
        schedules: [{ period: 1, subject: "数学" }],
        notices: [],
        assignments: [],
      },
    ]);
  });

  it("3 種許可なら各日のセクションを保持する", () => {
    const writes = multiDayWrites(multi, ["schedules", "notices", "assignments"]);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.date).toBe("2026-06-29");
    expect(writes[1]?.date).toBe("2026-06-30");
  });
});
