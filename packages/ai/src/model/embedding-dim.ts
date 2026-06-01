/**
 * embedding 次元の **物理単一ソース**（#396 M-1）。
 *
 * `text-embedding-004` の出力次元 = 768。RAG の embedding を保存する pgvector 列
 * （`content_versions.embedding` / `ai_chat_messages.embedding`、`@kimiterrace/db` の `VECTOR_DIM`）と、
 * 生成側の検証（`embed.ts` の `EMBEDDING_DIM` チェック）は**必ず同一値**でなければならない。
 * 不一致は RAG の silent drift（cosine 距離が無意味化し誤った掲示物が引かれても気づけない）を生む。
 *
 * これまで `EMBEDDING_DIM`(ai) と `VECTOR_DIM`(db) は独立した二重定義で、片方だけ更新する事故の
 * 温床だった。本 module を唯一の定義箇所とし、`db/pgvector.ts` は `@kimiterrace/ai/embedding-dim`
 * 経由で取り込んで `VECTOR_DIM` を派生させる（barrel ではなく **zero-import の専用 subpath** にして、
 * Vertex SDK 等の重い依存を db schema / drizzle-kit の評価経路へ持ち込まない）。
 *
 * ★ モデル/次元の変更（例: `gemini-embedding-001` = 3072 次元への移行）は **ここ 1 箇所**を変えれば
 *   ai/db 両層に伝播する。ただし既存 embedding の全件再生成 migration が必要（#396 M-2 / ADR-007 追補で確定）。
 *
 * 参照: ADR-007 (pgvector), ADR-005 (Vertex AI), #396 (M-1), #365 (F06 S2)。本 module は副作用・import なし。
 */
export const EMBEDDING_DIM = 768;
