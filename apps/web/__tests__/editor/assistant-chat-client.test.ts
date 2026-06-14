import { describe, expect, it } from "vitest";
import {
  applyChatFrame,
  beginUserTurn,
  type ChatState,
  initialChatState,
  parseSseFrames,
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
