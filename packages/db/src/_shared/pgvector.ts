import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector の vector 型を Drizzle に教えるための customType（ADR-007）。
 *
 * dimension は単一ソースとしてこのファイルでのみ定義する。
 * Gemini text-embedding-004 の出力次元 = 768 を採用。
 *
 * **重要**: embedding model 切替（例: text-embedding-004 → 別 model）時は
 * `VECTOR_DIM` の更新と pgvector index の rebuild が必須。複数ファイルに
 * customType を inline 定義すると片方だけ更新されて embedding space が
 * silent drift し RAG が壊れるため、必ずこの単一定義を import すること。
 *
 * 参照: ADR-007 (pgvector), CLAUDE.md ルール4 (PII マスキング後 embedding),
 *       PR #71 Reviewer H-2 (重複定義の指摘)
 */
export const VECTOR_DIM = 768;

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${VECTOR_DIM})`;
  },
});
