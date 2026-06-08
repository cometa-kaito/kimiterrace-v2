import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeDraftElement } from "../notice-draft-stream.js";

/**
 * エディタ AI 連絡ドラフト（#243 ②, ADR-033）構造化ストリーミングアダプタのテスト。
 *
 * `ai` の `streamObject` と `@ai-sdk/google-vertex` の `createVertex` を vi.mock し、GCP / 実モデル無しで
 * アダプタの **配線** を決定論的に固定する（ADR-012, chat-stream.test と同方針）: ①system/prompt と
 * array mode 指定をモデルへ渡す ②elementStream を素通しする ③done がバージョンピンした modelVersion /
 * 応答（output）トークン数を返す。実モデルの構造化出力品質は本テストの対象外（アダプタ層の責務は配線のみ、
 * 実挙動は staging の AI_ENABLED で検証）。
 */

const streamObjectMock = vi.fn();
vi.mock("ai", () => ({ streamObject: (args: unknown) => streamObjectMock(args) }));
vi.mock("@ai-sdk/google-vertex", () => ({
  // createVertex(config) → (modelId) => model。実モデルを生成せず識別子だけ載せたフェイクを返す。
  createVertex: () => (modelId: string) => ({ __fakeModel: modelId }),
}));

import { createVertexNoticeStreamClient } from "../notice-draft-stream.js";

/** streamObject(array) の戻り（StreamObjectResult）を模した最小フェイク。usage は完了後解決の Promise。 */
function fakeStreamResult(opts: { elements: NoticeDraftElement[]; outputTokens?: number }) {
  return {
    elementStream: (async function* () {
      for (const e of opts.elements) yield e;
    })(),
    usage: Promise.resolve({
      inputTokens: 5,
      outputTokens: opts.outputTokens ?? 7,
      totalTokens: 5 + (opts.outputTokens ?? 7),
    }),
  };
}

/** elementStream を配列へ集約する（全要素を消費して完了を駆動）。 */
async function collect(stream: AsyncIterable<NoticeDraftElement>): Promise<NoticeDraftElement[]> {
  const out: NoticeDraftElement[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

beforeEach(() => {
  streamObjectMock.mockReset();
});

describe("createVertexNoticeStreamClient", () => {
  it("system/prompt と array mode + 要素スキーマをモデルへ渡し、elementStream を素通しする", async () => {
    const elements: NoticeDraftElement[] = [
      { text: "明日は短縮授業です。", isHighlight: false },
      { text: "図書室の返却は金曜まで。", isHighlight: true },
    ];
    streamObjectMock.mockReturnValue(fakeStreamResult({ elements }));
    const client = createVertexNoticeStreamClient({ project: "p", location: "asia-northeast1" });

    const r = client.stream({ system: "SYS-PROMPT", user: "USER-PROMPT" });
    expect(await collect(r.elementStream)).toEqual(elements);

    const arg = streamObjectMock.mock.calls[0]?.[0];
    expect(arg.system).toBe("SYS-PROMPT");
    expect(arg.prompt).toBe("USER-PROMPT");
    expect(arg.output).toBe("array");
    // 要素スキーマが渡っている（構造のみ規定）。
    expect(arg.schema).toBeDefined();
  });

  it("done は指定 modelVersion・応答（output）トークン数を返す", async () => {
    streamObjectMock.mockReturnValue(
      fakeStreamResult({ elements: [{ text: "連絡", isHighlight: false }], outputTokens: 12 }),
    );
    const client = createVertexNoticeStreamClient({
      project: "p",
      location: "l",
      modelId: "gemini-test-xyz",
    });

    const r = client.stream({ system: "s", user: "u" });
    await collect(r.elementStream);
    expect(await r.done).toEqual({ modelVersion: "gemini-test-xyz", tokenCount: 12 });
  });

  it("modelId 未指定なら ADR-017 の Gemini 2.5 Flash をピンする", async () => {
    streamObjectMock.mockReturnValue(
      fakeStreamResult({ elements: [{ text: "x", isHighlight: false }] }),
    );
    const client = createVertexNoticeStreamClient({ project: "p", location: "l" });

    const r = client.stream({ system: "s", user: "u" });
    await collect(r.elementStream);
    expect((await r.done).modelVersion).toBe("gemini-2.5-flash");
  });

  it("usage.outputTokens 欠落時は tokenCount=0 にフォールバックする", async () => {
    streamObjectMock.mockReturnValue({
      elementStream: (async function* () {
        yield { text: "ok", isHighlight: false };
      })(),
      usage: Promise.resolve({ inputTokens: 3, totalTokens: 3 }),
    });
    const client = createVertexNoticeStreamClient({ project: "p", location: "l" });

    const r = client.stream({ system: "s", user: "u" });
    await collect(r.elementStream);
    expect((await r.done).tokenCount).toBe(0);
  });
});
