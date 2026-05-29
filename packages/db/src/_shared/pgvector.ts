import { customType } from "drizzle-orm/pg-core";

/**
 * Gemini text-embedding-004 の次元。
 * 将来モデル変更時は本定数のみ更新し、両 schema 側に反映される。
 * ADR-007 pgvector
 */
export const VECTOR_DIM = 768;

/**
 * pgvector の vector(N) 型を Drizzle に教える customType。
 * content-versions.ts / ai-chat-messages.ts 等から共通利用する。
 * 重複定義禁止（dimension drift で RAG 破壊するため、PR #71 Reviewer High 2 指摘）。
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${VECTOR_DIM})`;
  },
});
