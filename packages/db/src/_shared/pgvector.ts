import { EMBEDDING_DIM } from "@kimiterrace/ai/embedding-dim";
import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector 列の次元。embedding 次元の**物理単一ソースは `@kimiterrace/ai` の `EMBEDDING_DIM`**
 * （#396 M-1）。ここはそれを `VECTOR_DIM` として束ねるだけで、独自に数値を持たない。
 * これにより生成側（embed.ts の次元検証）と保存側（vector 列）が構造的に一致し、片方だけ更新する
 * silent drift を排除する。モデル/次元の変更は ai 側の 1 箇所のみ（再 embedding migration は #396 M-2）。
 * 重い Vertex SDK を持ち込まないため barrel ではなく zero-import の `/embedding-dim` subpath を使う。
 * 参照: ADR-007 (pgvector)、CLAUDE.md ルール 4 (PII マスキング後の embedding 生成)
 */
export const VECTOR_DIM = EMBEDDING_DIM;

/**
 * pgvector の vector 型を Drizzle に教える customType。
 * dimension 不一致による RAG silent drift を防ぐため、全 schema は本 module 経由で参照すること。
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${VECTOR_DIM})`;
  },
});
