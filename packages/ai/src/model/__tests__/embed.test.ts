import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vertex embedding アダプタ（`createVertexEmbeddingClient`）のランタイム契約テスト。
 *
 * `@ai-sdk/google-vertex` を `vi.mock` して EmbeddingModelV2 spec の最小フェイクを差し込み、
 * 実 `embedMany`（Vercel AI SDK）を経由させて以下を固定する:
 *
 *  1. 入力テキストを `values` としてモデルへ渡し、結果を入力順で返す。
 *  2. 空入力では Vertex を呼ばず即 `[]` を返す（無駄な API 呼び出し / 課金を避ける）。
 *  3. 既定モデル ID は `gemini-embedding-001`（ADR-007 追補, #396 M-2）、明示指定はそれを尊重する。
 *  4. MRL 切り詰めの `outputDimensionality = EMBEDDING_DIM` を provider option（google 名前空間）で渡す。
 *  5. 返り値を L2 正規化（unit length）する（ADR-007 追補 §3 必須実装指示）。
 *  6. 次元不一致（RAG silent drift の根）を `EmbeddingError` で **生成直後に** 弾く。
 *  7. 非有限値・正規化不能（全ゼロ = ノルム 0）も `EmbeddingError` で弾く。
 *
 * provider 自身の生成能力は再テストしない（フェイクが決定的に応答を返す）。
 */

/** EmbeddingModelV2 spec のうち実 `embedMany` がランタイムで触る最小サブセット。 */
type FakeEmbeddingModel = {
  specificationVersion: "v2";
  provider: string;
  modelId: string;
  maxEmbeddingsPerCall: number;
  supportsParallelCalls: boolean;
  doEmbed(options: {
    values: string[];
    providerOptions?: Record<string, Record<string, unknown>>;
  }): Promise<{
    embeddings: number[][];
    usage: { tokens: number };
  }>;
};

/** doEmbed に渡った values を捕捉（呼び出し回数・内容の検証用）。 */
const capturedValues: string[][] = [];
/** textEmbeddingModel に渡った modelId を捕捉（既定 / 明示指定の検証用）。 */
const capturedModelIds: string[] = [];
/** doEmbed に渡った providerOptions を捕捉（outputDimensionality passthrough の検証用）。 */
const capturedProviderOptions: Array<Record<string, Record<string, unknown>> | undefined> = [];

/** 各テストで差し替えるフェイク応答の設定。`beforeEach` で既定に戻す。 */
let nextFake: {
  /** 返す embedding の次元。EMBEDDING_DIM 以外にすると次元不一致を再現。 */
  dim: number;
  /** この index の embedding に非有限値を混ぜる（未指定なら全要素有限）。 */
  nonFiniteAt?: number;
  /** この index の embedding を全ゼロにする（ノルム 0 = 正規化不能を再現）。 */
  zeroAt?: number;
};

function buildFakeEmbeddingModel(modelId: string): FakeEmbeddingModel {
  capturedModelIds.push(modelId);
  return {
    specificationVersion: "v2",
    provider: "google.vertex.fake",
    modelId,
    // 1 回の doEmbed で全件返す（chunk 分割を起こさない）。
    maxEmbeddingsPerCall: Number.POSITIVE_INFINITY,
    supportsParallelCalls: true,
    async doEmbed({ values, providerOptions }) {
      capturedValues.push(values);
      capturedProviderOptions.push(providerOptions);
      const embeddings = values.map((_value, i) => {
        // index ごとに「定数オフセット (i+1) + 成分 0.001*(j+1)」で非共線にする。
        // 単なるスケール倍（共線）だと L2 正規化後に全 index が同一ベクトルへ潰れ、順序検証が無意味化する。
        const vec = Array.from({ length: nextFake.dim }, (_x, j) => 0.001 * (j + 1) + (i + 1));
        if (nextFake.zeroAt === i) {
          return vec.map(() => 0);
        }
        if (nextFake.nonFiniteAt === i) {
          vec[0] = Number.POSITIVE_INFINITY;
        }
        return vec;
      });
      return { embeddings, usage: { tokens: values.length } };
    },
  };
}

vi.mock("@ai-sdk/google-vertex", () => ({
  // createVertex({ project, location }) → { textEmbeddingModel(modelId) => fakeEmbeddingModelV2 }
  createVertex: vi.fn(() => ({
    textEmbeddingModel: (modelId: string) => buildFakeEmbeddingModel(modelId),
  })),
}));

// vi.mock は hoist されるため、対象モジュールは mock 後に動的 import する。
const { createVertexEmbeddingClient, EmbeddingError, EMBEDDING_DIM } = await import("../embed.js");

const CONFIG = { project: "p", location: "asia-northeast1" } as const;

/** ベクトルの L2 ノルム。 */
function l2(vec: number[]): number {
  return Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
}

beforeEach(() => {
  capturedValues.length = 0;
  capturedModelIds.length = 0;
  capturedProviderOptions.length = 0;
  nextFake = { dim: EMBEDDING_DIM };
});

describe("createVertexEmbeddingClient", () => {
  it("入力テキストを順序どおり embedding に写し、values をモデルへ渡す", async () => {
    const client = createVertexEmbeddingClient(CONFIG);
    const out = await client.embed(["a", "b", "c"]);

    expect(out).toHaveLength(3);
    expect(out[0]).toHaveLength(EMBEDDING_DIM);
    expect(out[2]).toHaveLength(EMBEDDING_DIM);
    // a/b/c で異なる方向（index 由来の定数オフセット）→ 正規化後も順序が保たれている。
    expect(out[0]?.[0]).not.toBe(out[1]?.[0]);
    expect(capturedValues).toEqual([["a", "b", "c"]]);
  });

  it("空入力では Vertex を呼ばず空配列を返す", async () => {
    const client = createVertexEmbeddingClient(CONFIG);
    const out = await client.embed([]);

    expect(out).toEqual([]);
    expect(capturedValues).toHaveLength(0);
  });

  it("既定は gemini-embedding-001、modelId 指定はそれを尊重する", async () => {
    createVertexEmbeddingClient(CONFIG);
    expect(capturedModelIds).toContain("gemini-embedding-001");

    capturedModelIds.length = 0;
    createVertexEmbeddingClient({ ...CONFIG, modelId: "text-multilingual-embedding-002" });
    expect(capturedModelIds).toContain("text-multilingual-embedding-002");
    expect(capturedModelIds).not.toContain("gemini-embedding-001");
  });

  it("outputDimensionality = EMBEDDING_DIM を google provider option で渡す（MRL 切り詰め）", async () => {
    const client = createVertexEmbeddingClient(CONFIG);
    await client.embed(["x"]);

    expect(capturedProviderOptions[0]?.google?.outputDimensionality).toBe(EMBEDDING_DIM);
  });

  it("返り値を L2 正規化する（unit length, ADR-007 追補 §3）", async () => {
    const client = createVertexEmbeddingClient(CONFIG);
    const out = await client.embed(["a", "b"]);

    for (const vec of out) {
      expect(l2(vec)).toBeCloseTo(1, 6);
    }
  });

  it("次元不一致は EmbeddingError で弾く（RAG silent drift 防止）", async () => {
    nextFake = { dim: EMBEDDING_DIM - 1 };
    const client = createVertexEmbeddingClient(CONFIG);

    await expect(client.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it("非有限値を含む embedding は EmbeddingError で弾く", async () => {
    nextFake = { dim: EMBEDDING_DIM, nonFiniteAt: 1 };
    const client = createVertexEmbeddingClient(CONFIG);

    await expect(client.embed(["x", "y"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it("全ゼロ（ノルム 0）の embedding は正規化不能で EmbeddingError", async () => {
    nextFake = { dim: EMBEDDING_DIM, zeroAt: 0 };
    const client = createVertexEmbeddingClient(CONFIG);

    await expect(client.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
  });
});
