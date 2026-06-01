import type { wrapLanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type EffectCommentStats, buildEffectCommentPrompt } from "../../prompt/effect-comment.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../client.js";

/**
 * F08 効果コメント モデル層のテスト。
 *
 * 2 層に分けて固定する:
 *  - `generateEffectComment`: 抽象 `ModelClient` を fake 注入し、GCP 不要で「builder → 呼び出し →
 *    trim / 非空検証」のオーケストレーションを決定論的に検証（ADR-012）。
 *  - `createVertexEffectCommentClient`: vertex.test.ts と同じく `@ai-sdk/google-vertex` を vi.mock し、
 *    F03 アダプタとの**決定的な差**＝「JSON モード（responseFormat）を注入しない＝自然文出力」を
 *    ランタイムで固定する（型チェックだけでは守られない契約）。
 */

// ---- 共通: 月次集計サンプル（マスク済みタイトル前提） -------------------------------------------
const STATS: EffectCommentStats = {
  month: "2026-05",
  metrics: [
    { label: "閲覧", current: 1200, previous: 900 },
    { label: "タップ", current: 80, previous: 100 },
    { label: "Q&A", current: 15, previous: null },
  ],
  topContent: [
    { title: "{{CONTENT_001}}", reactions: 320 },
    { title: "{{CONTENT_002}}", reactions: 210 },
  ],
};

// ---- 1) generateEffectComment（fake ModelClient 注入） -----------------------------------------
function fakeClient(text: string, capture?: (req: ModelRequest) => void): ModelClient {
  return {
    async generate(req: ModelRequest): Promise<ModelResponse> {
      capture?.(req);
      return {
        text,
        usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
        modelVersion: "fake-model-001",
      };
    },
  };
}

describe("generateEffectComment", () => {
  it("決定論的 builder の system/user をそのままモデルへ渡す", async () => {
    const expected = buildEffectCommentPrompt(STATS);
    let seen: ModelRequest | undefined;
    const { generateEffectComment } = await import("../effect-comment-model.js");

    await generateEffectComment(
      fakeClient("先月比で閲覧が伸びています。", (req) => {
        seen = req;
      }),
      STATS,
    );

    // builder を迂回して独自にプロンプトを組んでいない（=単一ソースの builder に委譲）ことを固定。
    expect(seen?.system).toBe(expected.system);
    expect(seen?.user).toBe(expected.user);
  });

  it("コメントを trim し、usage / modelVersion を素通しする", async () => {
    const { generateEffectComment } = await import("../effect-comment-model.js");

    const res = await generateEffectComment(fakeClient("  閲覧が好調です。\n"), STATS);

    expect(res.comment).toBe("閲覧が好調です。"); // 前後空白・改行は除去
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect(res.modelVersion).toBe("fake-model-001");
  });

  it("空 / 空白のみのモデル出力は EmptyEffectCommentError で弾く（空コメントを保存させない）", async () => {
    const { generateEffectComment, EmptyEffectCommentError } = await import(
      "../effect-comment-model.js"
    );

    await expect(generateEffectComment(fakeClient("   \n\t "), STATS)).rejects.toBeInstanceOf(
      EmptyEffectCommentError,
    );
    await expect(generateEffectComment(fakeClient(""), STATS)).rejects.toBeInstanceOf(
      EmptyEffectCommentError,
    );
  });
});

// ---- 2) createVertexEffectCommentClient（Vertex アダプタ契約、vi.mock） -------------------------
type FakeLanguageModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type DoGenerateOptions = Parameters<FakeLanguageModel["doGenerate"]>[0];
type SdkUsage = Awaited<ReturnType<FakeLanguageModel["doGenerate"]>>["usage"];

const capturedOptions: DoGenerateOptions[] = [];
let nextFakeConfig: { text: string; usage: SdkUsage; modelId: string };

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

vi.mock("@ai-sdk/google-vertex", () => ({
  createVertex: vi.fn(() => (modelId: string) => buildFakeModel({ ...nextFakeConfig, modelId })),
}));

const { createVertexEffectCommentClient } = await import("../effect-comment-model.js");

const DUMMY_CONFIG = { project: "dummy-project", location: "asia-northeast1" };
const FULL_USAGE: SdkUsage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };

beforeEach(() => {
  capturedOptions.length = 0;
  nextFakeConfig = { text: "コメント本文", usage: FULL_USAGE, modelId: "" };
});

describe("createVertexEffectCommentClient（Vertex アダプタ契約）", () => {
  it("JSON モードを注入しない（responseFormat 未設定 = 自然文出力）", async () => {
    const client = createVertexEffectCommentClient(DUMMY_CONFIG);

    await client.generate({ system: "sys", user: "usr" });

    expect(capturedOptions).toHaveLength(1);
    // F03 アダプタは { type: "json" } を注入する。本アダプタは散文なので注入してはいけない。
    expect(capturedOptions[0]?.responseFormat).toBeUndefined();
  });

  it("SDK usage（input/output/total）を ModelResponse.usage へ写像する", async () => {
    const res = await createVertexEffectCommentClient(DUMMY_CONFIG).generate({
      system: "s",
      user: "u",
    });
    expect(res.text).toBe("コメント本文");
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });

  it("usage 各フィールド欠落は 0 にフォールバックする", async () => {
    nextFakeConfig = {
      text: "本文",
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      modelId: "",
    };
    const res = await createVertexEffectCommentClient(DUMMY_CONFIG).generate({
      system: "s",
      user: "u",
    });
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("既定 modelId は ADR-017 の Gemini Pro ピン、明示指定も反映する", async () => {
    const def = await createVertexEffectCommentClient(DUMMY_CONFIG).generate({
      system: "s",
      user: "u",
    });
    expect(def.modelVersion).toBe("gemini-1.5-pro-002");

    const explicit = await createVertexEffectCommentClient({
      ...DUMMY_CONFIG,
      modelId: "gemini-2.0-flash-001",
    }).generate({ system: "s", user: "u" });
    expect(explicit.modelVersion).toBe("gemini-2.0-flash-001");
  });
});
