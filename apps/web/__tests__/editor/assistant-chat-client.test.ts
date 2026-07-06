import { describe, expect, it } from "vitest";
import {
  applyChatFrame,
  beginUserTurn,
  chatErrorMessage,
  type ChatState,
  finalizeInterruptedTurn,
  finalizeUnterminatedTurn,
  initialChatState,
  isRetryableError,
  parseSseFrames,
  rebaseDraftBeforeFirstTurn,
} from "../../lib/editor/assistant-chat-client";

/**
 * 会話型 AI クライアント core（UIレーン）の純ロジック検証。バックエンド route 無しで、契約
 * （`assistant-chat-core.ts`）の SSE フレームを synthetic に流して状態遷移を pin する。
 */

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("parseSseFrames", () => {
  it("完全フレームを切り出し、未完の末尾は rest に持ち越す", () => {
    const buf = `${frame("meta", { pattern: "pattern1", allowedSections: ["schedules"] })}${frame(
      "message",
      { delta: "hi" },
    )}event: mes`;
    const { frames, rest } = parseSseFrames(buf);
    expect(frames).toHaveLength(2);
    const [first, second] = frames;
    if (!first || !second) throw new Error("expected 2 frames");
    expect(first.event).toBe("meta");
    expect(second.event).toBe("message");
    expect(JSON.parse(second.data)).toEqual({ delta: "hi" });
    expect(rest).toBe("event: mes");
  });

  it("空バッファ/未完のみは frames 空・rest 持ち越し", () => {
    expect(parseSseFrames("")).toEqual({ frames: [], rest: "" });
    expect(parseSseFrames("event: meta\ndata: {")).toEqual({
      frames: [],
      rest: "event: meta\ndata: {",
    });
  });
});

describe("applyChatFrame", () => {
  it("meta でパターンと許可セクションを取り込む", () => {
    const s = applyChatFrame(initialChatState(), {
      event: "meta",
      data: JSON.stringify({ pattern: "pattern2", allowedSections: ["schedules"] }),
    });
    expect(s.pattern).toBe("pattern2");
    expect(s.allowedSections).toEqual(["schedules"]);
  });

  it("message delta を逐次連結する", () => {
    let s = initialChatState();
    s = applyChatFrame(s, { event: "message", data: JSON.stringify({ delta: "こん" }) });
    s = applyChatFrame(s, { event: "message", data: JSON.stringify({ delta: "にちは" }) });
    expect(s.streamingText).toBe("こんにちは");
  });

  it("draft は契約型へ防御正規化する（不正セクションは空配列に倒す）", () => {
    const s = applyChatFrame(initialChatState(), {
      event: "draft",
      data: JSON.stringify({ schedules: "ばつ", notices: [], assignments: [] }),
    });
    expect(s.draft).toEqual({ schedules: [], notices: [], assignments: [] });
  });

  it("error は status=error にし理由と suspectedSurfaces を保持（入力・下書きは失わない）", () => {
    const base: ChatState = { ...initialChatState(), streamingText: "途中まで" };
    const s = applyChatFrame(base, {
      event: "error",
      data: JSON.stringify({ status: 200, reason: "pii_warning", suspectedSurfaces: ["田中"] }),
    });
    expect(s.status).toBe("error");
    expect(s.error?.reason).toBe("pii_warning");
    expect(s.error?.suspectedSurfaces).toEqual(["田中"]);
    expect(s.streamingText).toBe("途中まで");
  });

  it("done で進行中 prose を assistant ターンへ確定し status=done", () => {
    let s = beginUserTurn(initialChatState(), "明日の連絡");
    s = applyChatFrame(s, { event: "message", data: JSON.stringify({ delta: "まとめました" }) });
    s = applyChatFrame(s, {
      event: "done",
      data: JSON.stringify({ draft: { schedules: [], notices: [], assignments: [] } }),
    });
    expect(s.status).toBe("done");
    expect(s.streamingText).toBe("");
    expect(s.messages).toEqual([
      { role: "user", content: "明日の連絡" },
      { role: "assistant", content: "まとめました" },
    ]);
  });

  it("壊れた data のフレームは無視して現状を返す（fail-soft）", () => {
    const before = applyChatFrame(initialChatState(), {
      event: "message",
      data: JSON.stringify({ delta: "ok" }),
    });
    const after = applyChatFrame(before, { event: "message", data: "{壊れ" });
    expect(after).toEqual(before);
  });
});

describe("beginUserTurn", () => {
  it("user ターンを積みストリーミング開始・エラークリア", () => {
    const start: ChatState = {
      ...initialChatState(),
      error: { reason: "rate_limited" },
      status: "error",
    };
    const s = beginUserTurn(start, "やること");
    expect(s.messages.at(-1)).toEqual({ role: "user", content: "やること" });
    expect(s.status).toBe("streaming");
    expect(s.error).toBeNull();
  });
});

describe("chatErrorMessage", () => {
  it("理由ごとに具体的な教員向け文言を返す", () => {
    expect(chatErrorMessage("rate_limited")).toContain("混み合っています");
    expect(chatErrorMessage("stream_failed")).toContain("応答の生成に失敗");
    expect(chatErrorMessage("no_result")).toContain("言い方を変えて");
    expect(chatErrorMessage("pii_leak")).toContain("個人情報");
    expect(chatErrorMessage("empty")).toContain("内容を入力");
    expect(chatErrorMessage("too_long")).toContain("長すぎます");
  });

  it("未知/不正理由は安全な既定文言にフォールバックする", () => {
    expect(chatErrorMessage("invalid")).toContain("送信に失敗");
  });
});

describe("isRetryableError", () => {
  it("一時的失敗（通信障害・混雑）のみ再試行可", () => {
    expect(isRetryableError("stream_failed")).toBe(true);
    expect(isRetryableError("rate_limited")).toBe(true);
  });

  it("入力起因・PII・no_result は再試行不可（入力を変える必要がある）", () => {
    for (const r of [
      "invalid",
      "empty",
      "too_long",
      "pii_warning",
      "pii_leak",
      "no_result",
    ] as const) {
      expect(isRetryableError(r)).toBe(false);
    }
  });
});

describe("finalizeInterruptedTurn", () => {
  it("中断時: 途中の応答を assistant ターンへ確定し status=done・エラー無し・下書きは保持", () => {
    const base: ChatState = {
      ...beginUserTurn(initialChatState(), "明日の連絡"),
      streamingText: "ここまで作成",
      draft: { schedules: [{ period: 1, subject: "数学" }], notices: [], assignments: [] },
    };
    const s = finalizeInterruptedTurn(base);
    expect(s.status).toBe("done");
    expect(s.error).toBeNull();
    expect(s.streamingText).toBe("");
    expect(s.messages).toEqual([
      { role: "user", content: "明日の連絡" },
      { role: "assistant", content: "ここまで作成" },
    ]);
    // 途中まで届いた下書きは破棄しない（確認カードで反映/破棄を選べる）。
    expect(s.draft.schedules).toEqual([{ period: 1, subject: "数学" }]);
  });

  it("応答が空のまま中断したら assistant ターンは積まない（空メッセージを残さない）", () => {
    const base: ChatState = {
      ...beginUserTurn(initialChatState(), "やること"),
      streamingText: "  ",
    };
    const s = finalizeInterruptedTurn(base);
    expect(s.status).toBe("done");
    expect(s.messages).toEqual([{ role: "user", content: "やること" }]);
  });
});

describe("finalizeUnterminatedTurn", () => {
  it("終端フレーム無しでストリームが閉じたら（streaming のまま）再試行可能な stream_failed に畳む（永久ハング防止）", () => {
    // beginUserTurn は status=streaming。meta だけ受けて done/error が来ずに切れた状況を模す。
    const base = beginUserTurn(initialChatState(), "明日の連絡");
    const s = finalizeUnterminatedTurn(base);
    expect(s.status).toBe("error");
    expect(s.error?.reason).toBe("stream_failed");
    // stream_failed は再試行可（UI に「再試行」が出る）。
    expect(s.error ? isRetryableError(s.error.reason) : false).toBe(true);
  });

  it("既に done/error に達していれば現状をそのまま返す（終端フレーム受信済みは上書きしない）", () => {
    const done: ChatState = { ...initialChatState(), status: "done" };
    expect(finalizeUnterminatedTurn(done)).toBe(done);
    const errored: ChatState = {
      ...initialChatState(),
      status: "error",
      error: { reason: "pii_warning" },
    };
    expect(finalizeUnterminatedTurn(errored)).toBe(errored);
  });
});

describe("rebaseDraftBeforeFirstTurn", () => {
  const current = {
    schedules: [{ subject: "数学", period: 1 }],
    notices: [{ text: "体操服を忘れずに" }],
    assignments: [],
  };

  it("未送信（messages 空・idle）なら下書きの基底をフォーム現在値へ差し替える（P1: 手入力消失の是正）", () => {
    const base = initialChatState({ schedules: [], notices: [], assignments: [] });
    const s = rebaseDraftBeforeFirstTurn(base, current);
    expect(s.draft).toEqual(current);
    expect(s).not.toBe(base);
  });

  it("送信済み（messages あり）は会話の作業下書きを保つ（上書きしない）", () => {
    const talked = beginUserTurn(initialChatState(), "1限は英語");
    expect(rebaseDraftBeforeFirstTurn(talked, current)).toBe(talked);
  });

  it("ファイル取り込み後（messages 空でも status=done）は取り込み結果を保つ", () => {
    const imported: ChatState = {
      ...initialChatState({ schedules: [], notices: [{ text: "取込結果" }], assignments: [] }),
      status: "done",
    };
    expect(rebaseDraftBeforeFirstTurn(imported, current)).toBe(imported);
  });

  it("current が null/undefined（Provider 外）は従来挙動のまま（fail-soft）", () => {
    const base = initialChatState();
    expect(rebaseDraftBeforeFirstTurn(base, null)).toBe(base);
    expect(rebaseDraftBeforeFirstTurn(base, undefined)).toBe(base);
  });
});
