import { customType } from "drizzle-orm/pg-core";

/**
 * Gemini text-embedding-004 想定の embedding 次元。
 * モデル切替時はここを変更（content_versions.embedding / ai_chat_messages.embedding 双方に伝播）。
 * 参照: ADR-007 (pgvector)、CLAUDE.md ルール 4 (PII マスキング後の embedding 生成)
 */
export const VECTOR_DIM = 768;

/**
 * pgvector の vector 型を Drizzle に教える customType。
 * dimension 不一致による RAG silent drift を防ぐため、全 schema は本 module 経由で参照すること。
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${VECTOR_DIM})`;
  },
});
