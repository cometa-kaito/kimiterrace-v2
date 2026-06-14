import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantTurnPartial } from "../assistant-chat-stream.js";

/**
 * 会話型 AI アシスタント（finding 2b, ADR-033/036 の発展）構造化オブジェクト・ストリーミングアダプタの
 * テスト。`ai` の `streamObject` と `@ai-sdk/google-vertex` を vi.mock し、GCP/実モデル無しで配線を固定する
 * （notice-draft-stream.test と同方針, ADR-012）: ①system/prompt + 構造スキーマをモデルへ渡す
 * ②partialObjectStream を素通しする ③done が modelVersion / 応答トークン数を返す。実モデルの出力品質は対象外。
 */

const streamObjectMock = vi.fn();
vi.mock("ai", () => ({ streamObject: (args: unknown) => streamObjectMock(args) }));
vi.mock("@ai-sdk/google-vertex", () => ({
  createVertex: () => (modelId: string) => ({ __fakeModel: modelId }),
}));

import { createVertexAssistantChatClient } from "../assistant-chat-stream.js";

/** streamObject(object) の戻り（StreamObjectResult）を模した最小フェイク。usage は完了後解決の Promise。 */
function fakeStreamResult(opts: { partials: AssistantTurnPartial[]; outputTokens?: number }) {
  return {
    partialObjectStream: (async function* () {
      for (const p of opts.partials) yield p;
    })(),
    usage: Promise.resolve({
      inputTokens: 5,
      outputTokens: opts.outputTokens ?? 7,
      totalTokens: 5 + (opts.outputTokens ?? 7),
    }),
  };
}

async function collect(
  stream: AsyncIterable<AssistantTurnPartial>,
): Promise<AssistantTurnPartial[]> {
  const out: AssistantTurnPartial[] = [];
  for await (const p of stream) out.push(p);
  return out;
}

beforeEach(() => {
  streamObjectMock.mockReset();
});

describe("createVertexAssistantChatClient", () => {
  it("system/prompt + 構造スキーマをモデルへ渡し、partialObjectStream を素通しする", async () => {
    const partials: AssistantTurnPartial[] = [
      { reply: "了解" },
      { reply: "了解しました", schedules: [{ period: 1, subject: "数学" }] },
    ];
    streamObjectMock.mockReturnValue(fakeStreamResult({ partials }));
    const client = createVertexAssistantChatClient({ project: "p", location: "asia-northeast1" });

    const r = client.stream({ system: "SYS", user: "USER" });
    expect(await collect(r.partialStream)).toEqual(partials);

    const arg = streamObjectMock.mock.calls[0]?.[0];
    expect(arg.system).toBe("SYS");
    expect(arg.prompt).toBe("USER");
    // object mode（array 指定をしない）＋ 構造スキーマが渡っている。
    expect(arg.output).toBeUndefined();
    expect(arg.schema).toBeDefined();
  });

  it("done は指定 modelVersion・応答（output）トークン数を返す", async () => {
    streamObjectMock.mockReturnValue(
      fakeStreamResult({ partials: [{ reply: "x" }], outputTokens: 21 }),
    );
    const client = createVertexAssistantChatClient({
      project: "p",
      location: "l",
      modelId: "gemini-test-xyz",
    });

    const r = client.stream({ system: "s", user: "u" });
    await collect(r.partialStream);
    expect(await r.done).toEqual({ modelVersion: "gemini-test-xyz", tokenCount: 21 });
  });

  it("modelId 未指定なら ADR-017 の Gemini 2.5 Flash をピンする", async () => {
    streamObjectMock.mockReturnValue(fakeStreamResult({ partials: [{ reply: "x" }] }));
    const client = createVertexAssistantChatClient({ project: "p", location: "l" });

    const r = client.stream({ system: "s", user: "u" });
    await collect(r.partialStream);
    expect((await r.done).modelVersion).toBe("gemini-2.5-flash");
  });

  it("usage.outputTokens 欠落時は tokenCount=0 にフォールバックする", async () => {
    streamObjectMock.mockReturnValue({
      partialObjectStream: (async function* () {
        yield { reply: "ok" };
      })(),
      usage: Promise.resolve({ inputTokens: 3, totalTokens: 3 }),
    });
    const client = createVertexAssistantChatClient({ project: "p", location: "l" });

    const r = client.stream({ system: "s", user: "u" });
    await collect(r.partialStream);
    expect((await r.done).tokenCount).toBe(0);
  });
});
