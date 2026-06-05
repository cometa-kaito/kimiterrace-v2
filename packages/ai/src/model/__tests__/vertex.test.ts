import type { wrapLanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vertex アダプタ（`createVertexModelClient`）のランタイム契約テスト。
 *
 * PR #153（ai SDK v4→v5 移行）以降、このアダプタ seam を実行する経路が無かった
 * （オーケストレータのテストは fake `ModelClient` を注入し adapter を迂回）。本テストは
 * `@ai-sdk/google-vertex` を `vi.mock` して LanguageModelV2 spec の最小フェイクを差し込み、
 * 型チェックでしか守られていなかった以下 2 契約を **ランタイムで** 固定する:
 *
 *  1. native JSON モード注入: `wrapLanguageModel` + `forceJsonResponseMiddleware` が
 *     `doGenerate` の call params に `responseFormat: { type: "json" }` を必ず注入する。
 *  2. usage 写像: SDK の `inputTokens`/`outputTokens`/`totalTokens` を
 *     自前 `ModelResponse.usage`（`promptTokens`/`completionTokens`/`totalTokens`）へ
 *     `?? 0` フォールバック付きで写像する。
 *
 * provider 自体の生成能力は再テストしない（フェイクが決定的に応答を返す）。
 */

/**
 * `wrapLanguageModel({ model })` が受理する LanguageModelV2 型。`@ai-sdk/provider` を新規
 * 直接依存に足さずに型整合させるため、公開 API のシグネチャから抽出する。
 */
type FakeLanguageModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type DoGenerateOptions = Parameters<FakeLanguageModel["doGenerate"]>[0];
type SdkUsage = Awaited<ReturnType<FakeLanguageModel["doGenerate"]>>["usage"];

/** `doGenerate` に渡る call params を捕捉する spy。各テストで reset。 */
const capturedOptions: DoGenerateOptions[] = [];

/**
 * LanguageModelV2 spec の最小フェイク。`doGenerate` の引数を捕捉し、`generateText` が
 * 解決できる最小フィールド（v2 content 配列・usage・finishReason・warnings）を返す。
 */
function buildFakeModel(opts: {
  text: string;
  usage: SdkUsage;
  modelId: string;
}): FakeLanguageModel {
  return {
    specificationVersion: "v2",
    provider: "google.vertex.fake",
    modelId: opts.modelId,
    supportedUrls: {},
    async doGenerate(options: DoGenerateOptions) {
      capturedOptions.push(options);
      return {
        content: [{ type: "text" as const, text: opts.text }],
        finishReason: "stop" as const,
        usage: opts.usage,
        warnings: [],
      };
    },
    doStream() {
      throw new Error("doStream は本テストでは未使用");
    },
  };
}

/** 直近のフェイク設定を vi.mock 内の factory から参照できるよう module スコープに保持。 */
let nextFakeConfig: { text: string; usage: SdkUsage; modelId: string };

vi.mock("@ai-sdk/google-vertex", () => ({
  // `createVertex({ project, location })` → `(modelId) => fakeLanguageModelV2`
  createVertex: vi.fn(() => (modelId: string) => buildFakeModel({ ...nextFakeConfig, modelId })),
}));

// vi.mock は hoist されるため、対象モジュールは mock 後に動的 import する。
const { createVertexModelClient } = await import("../vertex.js");

const DUMMY_CONFIG = { project: "dummy-project", location: "asia-northeast1" };
const FULL_USAGE: SdkUsage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };

beforeEach(() => {
  capturedOptions.length = 0;
  nextFakeConfig = { text: "{}", usage: FULL_USAGE, modelId: "" };
});

describe("createVertexModelClient（Vertex アダプタ契約）", () => {
  it("native JSON モードを doGenerate の responseFormat に注入する", async () => {
    nextFakeConfig = { text: "{}", usage: FULL_USAGE, modelId: "" };
    const client = createVertexModelClient(DUMMY_CONFIG);

    await client.generate({ system: "sys", user: "usr" });

    expect(capturedOptions).toHaveLength(1);
    // middleware を外す / 別 type にすると落ちる構造。
    expect(capturedOptions[0]?.responseFormat).toEqual({ type: "json" });
  });

  it("SDK usage（input/output/total）を ModelResponse.usage へ正しく写像する", async () => {
    nextFakeConfig = { text: "{}", usage: FULL_USAGE, modelId: "" };
    const client = createVertexModelClient(DUMMY_CONFIG);

    const res = await client.generate({ system: "sys", user: "usr" });

    // input→prompt / output→completion の取り違えがあれば落ちる。
    expect(res.usage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
  });

  it("usage 各フィールド欠落（undefined）は 0 にフォールバックする", async () => {
    // SDK は usage オブジェクト自体は常に返すが、各トークン数は undefined になりうる。
    // 本番の `usage?.inputTokens ?? 0` 等のフォールバックが効くことを固定する。
    nextFakeConfig = {
      text: "{}",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      modelId: "",
    };
    const partialRes = await createVertexModelClient(DUMMY_CONFIG).generate({
      system: "s",
      user: "u",
    });
    expect(partialRes.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("text と modelVersion を返す（既定 modelId / 明示 modelId 双方）", async () => {
    nextFakeConfig = { text: '{"ok":true}', usage: FULL_USAGE, modelId: "" };
    const defaultRes = await createVertexModelClient(DUMMY_CONFIG).generate({
      system: "s",
      user: "u",
    });
    expect(defaultRes.text).toBe('{"ok":true}');
    // 既定は DEFAULT_MODEL_ID（#289 ④ で gemini-2.5-flash に更新、旧 1.5 Pro retired）。
    expect(defaultRes.modelVersion).toBe("gemini-2.5-flash");

    const explicitRes = await createVertexModelClient({
      ...DUMMY_CONFIG,
      modelId: "gemini-2.0-flash-001",
    }).generate({ system: "s", user: "u" });
    expect(explicitRes.text).toBe('{"ok":true}');
    expect(explicitRes.modelVersion).toBe("gemini-2.0-flash-001");
  });
});
