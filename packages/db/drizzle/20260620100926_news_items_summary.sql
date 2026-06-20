-- news_items に公式要約（summary）列を追加（ADR-043 §2026-06-20 改訂）。
-- CC BY ソース（経産省 METI = PDL1.0）のみ非 null・要許諾ソース（JST 等）は null（gate は取得 Job 側）。
-- nullable text。既存行は null のまま（見出しのみ）で互換、RLS も既存の read_all/write_system のままで不変。
-- ⚠ drizzle-kit generate は古い snapshot との差分で air_quality_index 再作成等の無関係ドリフトを
--   同梱して生成した（Issue #195 系の snapshot ドリフト）。本 SQL は **news_items の summary 追加 1 文のみ**へ
--   trim 済（snapshot/journal は維持＝孤立 migration を作らない）。再実行に強いよう IF NOT EXISTS で冪等化。
ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "summary" text;
