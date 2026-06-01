import { createVertex } from "@ai-sdk/google-vertex";
import { embedMany } from "ai";

/**
 * Vertex AI テキスト embedding アダプタ（ADR-005 Vertex AI / ADR-006 Vercel AI SDK / ADR-007 pgvector）。
 *
 * F06 (#365) の RAG はこのクライアントを 2 経路で共有する:
 *   1. 公開コンテンツの embedding 生成バッチ（S2 後続スライス、apps/jobs → content_versions.embedding）。
 *   2. 生徒質問の embedding 生成（S6 SSE route）— rag-search.ts の cosine 検索に渡す。
 *
 * 設計上の規律:
 * - **PII（ルール4）**: 本アダプタは渡されたテキストを **そのまま** Vertex へ送る。マスキングは
 *   呼び出し側の責務に固定する（バッチは snapshot を maskPII してから渡す）。アダプタにマスキングを
 *   抱えさせると「マスク済みか」の判断が二重化し、未マスク混入の温床になるため境界を上流へ置く。
 * - **次元の単一ソース（ADR-007）**: `text-embedding-004` は 768 次元で、@kimiterrace/db の
 *   `VECTOR_DIM`（content_versions.embedding / ai_chat_messages.embedding）と一致する。次元不一致は
 *   RAG の silent drift（cosine 距離が無意味化し、誤った掲示物が引かれても気づけない）を生むため、
 *   生成直後に `EMBEDDING_DIM` で検証し、不一致・非有限値はクエリ層（rag-search.ts の toVectorLiteral）
 *   へ持ち越さず **ここで throw** する。
 * - **認証（ルール5）**: ADC / Workload Identity 経由（JSON キーファイル禁止）。createVertexModelClient と同様、
 *   `@ai-sdk/google-vertex` が google-auth-library で ADC を解決する。
 * - **データ越境ゼロ（NFR07）**: location は注入する（asia-northeast1 運用）。ハードコードしない。
 */

/**
 * embedding 次元。`text-embedding-004` の出力次元であり、@kimiterrace/db の `VECTOR_DIM`
 * （packages/db の pgvector.ts）と一致させること。モデルを変えて次元が変わる場合は両方を同時に更新する。
 */
export const EMBEDDING_DIM = 768;

/** バージョンピンした embedding モデル ID（既定）。 */
const DEFAULT_EMBEDDING_MODEL_ID = "text-embedding-004";

export interface VertexEmbeddingConfig {
  /** GCP プロジェクト ID（例: signage-v2-prod）。 */
  project: string;
  /** リージョン。asia-northeast1 固定運用（NFR07、データ越境ゼロ）。 */
  location: string;
  /** バージョンピンした embedding モデル ID。既定は text-embedding-004。 */
  modelId?: string;
}

export interface EmbeddingClient {
  /**
   * 複数テキストの embedding をまとめて生成する。返り値は入力 `texts` と同じ順序・同じ件数。
   * 空配列なら Vertex を呼ばず空配列を返す。
   *
   * @throws {EmbeddingError} いずれかの embedding が `EMBEDDING_DIM` 次元でない、または非有限値を含む場合。
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * embedding 生成の契約違反（次元不一致 / 非有限値）。
 * RAG の silent drift を下流（pgvector への bind、cosine 検索）まで持ち越さず上流で止めるための専用型。
 */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** 1 件の embedding が次元・有限性の契約を満たすか検証する。違反は EmbeddingError。 */
function assertValidEmbedding(vec: number[], index: number): void {
  if (vec.length !== EMBEDDING_DIM) {
    throw new EmbeddingError(
      `embedding 次元が不正です (index=${index}, 実際=${vec.length}, 期待=${EMBEDDING_DIM})`,
    );
  }
  for (const x of vec) {
    if (!Number.isFinite(x)) {
      throw new EmbeddingError(`embedding に非有限値が含まれます (index=${index})`);
    }
  }
}

/**
 * Vertex AI の text embedding クライアントを生成する。
 *
 * `embedMany`（Vercel AI SDK）に複数テキストをまとめて渡し、モデル側のバッチ上限に応じた分割は
 * SDK に委ねる。返却順は入力順に一致する（SDK の契約）。
 */
export function createVertexEmbeddingClient(config: VertexEmbeddingConfig): EmbeddingClient {
  const vertex = createVertex({ project: config.project, location: config.location });
  const modelId = config.modelId ?? DEFAULT_EMBEDDING_MODEL_ID;
  const model = vertex.textEmbeddingModel(modelId);

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      const { embeddings } = await embedMany({ model, values: texts });
      embeddings.forEach(assertValidEmbedding);
      return embeddings;
    },
  };
}
