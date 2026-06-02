import { createVertex } from "@ai-sdk/google-vertex";
import { embedMany } from "ai";
import { EMBEDDING_DIM } from "./embedding-dim.js";

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
 * - **採用モデル / 次元（ADR-007 追補 2026-06-01, #396 M-2）**: deprecated な `text-embedding-004` を
 *   置換し **`gemini-embedding-001`**（GA・多言語/日本語対応、旧 specialized モデルを統合）を採用。既定
 *   3072 次元を **MRL 切り詰め（`outputDimensionality = 768`）** で 768 にし、@kimiterrace/db の
 *   `VECTOR_DIM`（content_versions.embedding / ai_chat_messages.embedding）= 768 を据え置く（スキーマ非変更）。
 * - **L2 正規化（ADR-007 追補 §3 必須実装指示）**: `gemini-embedding-001` は **3072 未満に切り詰めた
 *   出力を自動正規化しない**（自動正規化は後継 `gemini-embedding-2` のみ）。本アダプタは生成直後に各
 *   ベクトルを **L2 正規化（unit length）して返す**ので、バッチ格納ベクトルとクエリベクトルが同一経路で
 *   正規化される。これを怠ると magnitude のばらつきで cosine / 内積 / L2 の順位が歪む。pgvector の
 *   cosine（`<=>`）自体は scale 不変だが、将来の内積/L2 索引・距離関数変更への防御として正規化を固定する。
 * - **次元の単一ソース（ADR-007 / #396 M-1）**: 次元不一致は RAG の silent drift（cosine 距離が無意味化し、
 *   誤った掲示物が引かれても気づけない）を生むため、生成直後に `EMBEDDING_DIM` で検証し、不一致・非有限値・
 *   正規化不能（ノルム 0）はクエリ層（rag-search.ts の toVectorLiteral）へ持ち越さず **ここで throw** する。
 * - **認証（ルール5）**: ADC / Workload Identity 経由（JSON キーファイル禁止）。createVertexModelClient と同様、
 *   `@ai-sdk/google-vertex` が google-auth-library で ADC を解決する。
 * - **データ越境ゼロ（NFR07）**: location は注入する（asia-northeast1 運用）。ハードコードしない。
 */

// embedding 次元の物理単一ソースは ./embedding-dim.js（#396 M-1）。@kimiterrace/db の VECTOR_DIM も
// そこから派生する。barrel（@kimiterrace/ai）互換のため re-export する。
export { EMBEDDING_DIM };

/**
 * バージョンピンした embedding モデル ID（既定）。
 * ADR-007 追補（#396 M-2）で deprecated な `text-embedding-004` から `gemini-embedding-001` へ確定。
 */
const DEFAULT_EMBEDDING_MODEL_ID = "gemini-embedding-001";

export interface VertexEmbeddingConfig {
  /** GCP プロジェクト ID（例: signage-v2-prod）。 */
  project: string;
  /** リージョン。asia-northeast1 固定運用（NFR07、データ越境ゼロ）。 */
  location: string;
  /** バージョンピンした embedding モデル ID。既定は gemini-embedding-001（ADR-007 追補）。 */
  modelId?: string;
}

export interface EmbeddingClient {
  /**
   * 複数テキストの embedding をまとめて生成し、各ベクトルを **L2 正規化（unit length）** して返す。
   * 返り値は入力 `texts` と同じ順序・同じ件数。空配列なら Vertex を呼ばず空配列を返す。
   *
   * @throws {EmbeddingError} いずれかの embedding が `EMBEDDING_DIM` 次元でない、非有限値を含む、
   *   または L2 ノルムが 0 / 非有限で正規化できない場合。
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * embedding 生成の契約違反（次元不一致 / 非有限値 / 正規化不能）。
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
 * embedding を L2 正規化（unit length）する（ADR-007 追補 §3 必須実装指示）。
 * gemini-embedding-001 は 768 次元（< 3072）出力を自動正規化しないため、生成側で固定する。
 * ノルムが 0（全ゼロ）/ 非有限なら正規化できず cosine が無意味化するため EmbeddingError で弾く。
 */
function l2Normalize(vec: number[], index: number): number[] {
  let sumSq = 0;
  for (const x of vec) {
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingError(`embedding を L2 正規化できません (index=${index}, norm=${norm})`);
  }
  return vec.map((x) => x / norm);
}

/**
 * Vertex AI の text embedding クライアントを生成する。
 *
 * `embedMany`（Vercel AI SDK）に複数テキストをまとめて渡し、モデル側のバッチ上限に応じた分割は
 * SDK に委ねる。返却順は入力順に一致する（SDK の契約）。`outputDimensionality`（MRL 切り詰め）は
 * provider option（`google` 名前空間）で 768 に固定する。
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
      const { embeddings } = await embedMany({
        model,
        values: texts,
        // gemini-embedding-001 の既定 3072 を MRL で 768 に切り詰める（ADR-007 追補 §2）。
        // @ai-sdk/google-vertex は embedding の provider option を "google" 名前空間で読む。
        providerOptions: { google: { outputDimensionality: EMBEDDING_DIM } },
      });
      embeddings.forEach(assertValidEmbedding);
      // ADR-007 追補 §3: 切り詰め出力は自動正規化されないため生成側で L2 正規化を固定する。
      return embeddings.map((vec, i) => l2Normalize(vec, i));
    },
  };
}
