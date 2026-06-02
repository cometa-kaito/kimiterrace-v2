import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F06 (#373) 生徒対話 SSE ストリーミングアダプタのテスト。
 *
 * `ai` の `streamText` と `@ai-sdk/google-vertex` の `createVertex` を vi.mock し、GCP / 実モデル無しで
 * アダプタの **配線** を決定論的に固定する (ADR-012): ①system/prompt をモデルへ渡す ②textStream を
 * 素通しする ③done がフル本文 / バージョンピンした modelVersion / 応答(output)トークン数を返す。
 * 実モデルの応答品質は本テストの対象外 (アダプタ層の責務は配線のみ)。
 */

const streamTextMock = vi.fn();
vi.mock("ai", () => ({ streamText: (args: unknown) => streamTextMock(args) }));
vi.mock("@ai-sdk/google-vertex", () => ({
  // createVertex(config) → (modelId) => model。実モデルを生成せず識別子だけ載せたフェイクを返す。
  createVertex: () => (modelId: string) => ({ __fakeModel: modelId }),
}));

import { createVertexChatStreamClient } from "../chat-stream.js";

/** streamText の戻り (StreamTextResult) を模した最小フェイク。text/usage は完了後解決の Promise。 */
function fakeStreamResult(opts: { chunks: string[]; fullText?: string; outputTokens?: number }) {
  return {
    textStream: (async function* () {
      for (const c of opts.chunks) yield c;
    })(),
    text: Promise.resolve(opts.fullText ?? opts.chunks.join("")),
    usage: Promise.resolve({
      inputTokens: 5,
      outputTokens: opts.outputTokens ?? 9,
      totalTokens: 5 + (opts.outputTokens ?? 9),
    }),
  };
}

/** textStream を結合する (チャンクを全消費して完了を駆動)。 */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of stream) out += c;
  return out;
}

beforeEach(() => {
  streamTextMock.mockReset();
});

describe("createVertexChatStreamClient", () => {
  it("system/prompt をモデルへ渡し、textStream を素通しする", async () => {
    streamTextMock.mockReturnValue(fakeStreamResult({ chunks: ["こん", "にちは"] }));
    const client = createVertexChatStreamClient({ project: "p", location: "asia-northeast1" });

    const r = client.stream({ system: "SYS-PROMPT", user: "USER-PROMPT" });
    expect(await drain(r.textStream)).toBe("こんにちは");

    const arg = streamTextMock.mock.calls[0]?.[0];
    expect(arg.system).toBe("SYS-PROMPT");
    expect(arg.prompt).toBe("USER-PROMPT");
  });

  it("done はフル本文・指定 modelVersion・応答(output)トークン数を返す", async () => {
    streamTextMock.mockReturnValue(
      fakeStreamResult({ chunks: ["A", "B"], fullText: "AB", outputTokens: 12 }),
    );
    const client = createVertexChatStreamClient({
      project: "p",
      location: "l",
      modelId: "gemini-test-xyz",
    });

    const r = client.stream({ system: "s", user: "u" });
    await drain(r.textStream);
    expect(await r.done).toEqual({
      fullText: "AB",
      modelVersion: "gemini-test-xyz",
      tokenCount: 12,
    });
  });

  it("modelId 未指定なら ADR-017 の Gemini Pro をピンする", async () => {
    streamTextMock.mockReturnValue(fakeStreamResult({ chunks: ["x"] }));
    const client = createVertexChatStreamClient({ project: "p", location: "l" });

    const r = client.stream({ system: "s", user: "u" });
    await drain(r.textStream);
    expect((await r.done).modelVersion).toBe("gemini-1.5-pro-002");
  });

  it("usage.outputTokens 欠落時は tokenCount=0 にフォールバックする", async () => {
    streamTextMock.mockReturnValue({
      textStream: (async function* () {
        yield "ok";
      })(),
      text: Promise.resolve("ok"),
      usage: Promise.resolve({ inputTokens: 3, totalTokens: 3 }),
    });
    const client = createVertexChatStreamClient({ project: "p", location: "l" });

    const r = client.stream({ system: "s", user: "u" });
    await drain(r.textStream);
    expect((await r.done).tokenCount).toBe(0);
  });
});
