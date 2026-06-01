import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vertex embedding アダプタ（`createVertexEmbeddingClient`）のランタイム契約テスト。
 *
 * `@ai-sdk/google-vertex` を `vi.mock` して EmbeddingModelV2 spec の最小フェイクを差し込み、
 * 実 `embedMany`（Vercel AI SDK）を経由させて以下を固定する:
 *
 *  1. 入力テキストを `values` としてモデルへ渡し、結果を入力順で返す。
 *  2. 空入力では Vertex を呼ばず即 `[]` を返す（無駄な API 呼び出し / 課金を避ける）。
 *  3. 既定モデル ID は `text-embedding-004`、明示指定はそれを尊重する。
 *  4. 次元不一致（RAG silent drift の根）を `EmbeddingError` で **生成直後に** 弾く。
 *  5. 非有限値を含む embedding も `EmbeddingError` で弾く。
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
  doEmbed(options: { values: string[] }): Promise<{
    embeddings: number[][];
    usage: { tokens: number };
  }>;
};

/** doEmbed に渡った values を捕捉（呼び出し回数・内容の検証用）。 */
const capturedValues: string[][] = [];
/** textEmbeddingModel に渡った modelId を捕捉（既定 / 明示指定の検証用）。 */
const capturedModelIds: string[] = [];

/** 各テストで差し替えるフェイク応答の設定。`beforeEach` で既定に戻す。 */
let nextFake: {
  /** 返す embedding の次元。EMBEDDING_DIM 以外にすると次元不一致を再現。 */
  dim: number;
  /** この index の embedding に非有限値を混ぜる（未指定なら全要素有限）。 */
  nonFiniteAt?: number;
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
    async doEmbed({ values }) {
      capturedValues.push(values);
      const embeddings = values.map((_value, i) => {
        const vec = Array.from({ length: nextFake.dim }, (_x, j) => (i + 1) * 0.001 * (j + 1));
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

beforeEach(() => {
  capturedValues.length = 0;
  capturedModelIds.length = 0;
  nextFake = { dim: EMBEDDING_DIM };
});

describe("createVertexEmbeddingClient", () => {
  it("入力テキストを順序どおり embedding に写し、values をモデルへ渡す", async () => {
    const client = createVertexEmbeddingClient(CONFIG);
    const out = await client.embed(["a", "b", "c"]);

    expect(out).toHaveLength(3);
    expect(out[0]).toHaveLength(EMBEDDING_DIM);
    expect(out[2]).toHaveLength(EMBEDDING_DIM);
    // a/b/c で異なるベクトル（index 由来でスケール）→ 順序が保たれている。
    expect(out[0]?.[0]).not.toBe(out[1]?.[0]);
    expect(capturedValues).toEqual([["a", "b", "c"]]);
  });

  it("空入力では Vertex を呼ばず空配列を返す", async () => {
    const client = createVertexEmbeddingClient(CONFIG);
    const out = await client.embed([]);

    expect(out).toEqual([]);
    expect(capturedValues).toHaveLength(0);
  });

  it("既定は text-embedding-004、modelId 指定はそれを尊重する", async () => {
    createVertexEmbeddingClient(CONFIG);
    expect(capturedModelIds).toContain("text-embedding-004");

    capturedModelIds.length = 0;
    createVertexEmbeddingClient({ ...CONFIG, modelId: "text-embedding-005" });
    expect(capturedModelIds).toContain("text-embedding-005");
    expect(capturedModelIds).not.toContain("text-embedding-004");
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
});
