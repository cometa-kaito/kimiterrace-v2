import { describe, expect, it } from "vitest";
import type { AssistantDraft, ChatTurn } from "../../lib/editor/assistant-chat-core";
import {
  buildAssistantChatSystem,
  buildAssistantChatUser,
  userAuthoredText,
} from "../../lib/editor/assistant-chat-prompt";

/**
 * 会話型 AI プロンプト構築（assistant-chat-prompt）の純ロジック検証。許可セクションの反映（finding①）・
 * 基準日・会話の平坦化・下書きの許可絞り・soft-gate 対象（user ターンのみ）を固める。
 */

const TURNS: ChatTurn[] = [
  { role: "user", content: "明日の予定を作って" },
  { role: "assistant", content: "作成しました" },
  { role: "user", content: "2限を英語に" },
];

describe("buildAssistantChatSystem", () => {
  it("許可セクションのラベルと基準日を含み、許可外は作らせない指示を出す", () => {
    const sys = buildAssistantChatSystem(
      ["schedules", "notices", "assignments"],
      "2026年6月13日（土）",
    );
    expect(sys).toContain("予定（時間割）");
    expect(sys).toContain("連絡（お知らせ）");
    expect(sys).toContain("提出物（課題）");
    expect(sys).toContain("2026年6月13日（土）");
    expect(sys).toContain("{ reply, schedules, notices, assignments }");
  });

  it("pattern2 相当（schedules のみ許可）= 予定だけを許可ラベルに出す", () => {
    const sys = buildAssistantChatSystem(["schedules"], "2026年6月13日（土）");
    expect(sys).toContain("予定（時間割）");
    expect(sys).not.toContain("連絡（お知らせ） /");
    // 「これ以外のセクションは作らない」誘導が入る。
    expect(sys).toContain("これ以外のセクションは作らない");
  });
});

describe("userAuthoredText", () => {
  it("user ターンのみを連結する（assistant 応答は soft-gate 対象外）", () => {
    expect(userAuthoredText(TURNS)).toBe("明日の予定を作って\n2限を英語に");
  });
});

describe("buildAssistantChatUser", () => {
  it("会話の平坦化（先生/アシスタント）と現在の下書き JSON を含む", () => {
    const draft: AssistantDraft = {
      schedules: [{ period: 1, subject: "数学" }],
      notices: [],
      assignments: [],
    };
    const user = buildAssistantChatUser(TURNS, draft, ["schedules", "notices", "assignments"]);
    expect(user).toContain("先生: 明日の予定を作って");
    expect(user).toContain("アシスタント: 作成しました");
    expect(user).toContain("先生: 2限を英語に");
    expect(user).toContain('"schedules":[{"period":1,"subject":"数学"}]');
  });

  it("下書きは許可セクションだけに絞って渡す（許可外は空配列で文脈に入れない）", () => {
    const draft: AssistantDraft = {
      schedules: [{ period: 1, subject: "数学" }],
      notices: [{ text: "連絡" }],
      assignments: [],
    };
    const user = buildAssistantChatUser(TURNS, draft, ["schedules"]);
    expect(user).toContain('"notices":[]');
    expect(user).not.toContain("連絡");
  });
});
