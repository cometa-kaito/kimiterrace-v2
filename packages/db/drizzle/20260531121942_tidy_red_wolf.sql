-- #75 (PR #71 Reviewer Medium M-1〜M-4): AI/RAG スキーマの enum 化 + index + 監査整合。
--
-- M-1: ai_extractions.status を varchar → ai_extraction_status enum 化（値域を DB 強制）。
--   varchar→enum は暗黙キャスト不可のため canonical な 3 段で行う:
--     1) 既存の varchar DEFAULT を外す（enum 化後に enum literal で貼り直す）
--     2) USING 明示キャストで型変換（既存値 success/retry/failed は enum label に一致）
--     3) DEFAULT を enum 値で再設定
-- M-2: success 行は raw_input_hash 必須（監査トレース整合）の CHECK 制約。
-- M-3/M-4: ADR-019 に従い school_id 先頭の複合 index を追加。bare (school_id) index は
--          複合に内包されるため drop（ix_ai_chat_sessions_school_id / ix_ai_chat_messages_school_id）。
--
-- 注: drizzle-kit generate は feedback テーブルの CREATE も出力したが、これは drizzle/0010_feedback.sql
--     で既に適用済み（スナップショット未記録だった drift を本 generate が解消）。本 migration からは
--     feedback の DDL を除去している（0010 が先行適用するため再作成は不要・不可）。スナップショット側は
--     現状（feedback 含む）を正しく反映する。
CREATE TYPE "public"."ai_extraction_status" AS ENUM('success', 'retry', 'failed');--> statement-breakpoint
DROP INDEX "ix_ai_chat_sessions_school_id";--> statement-breakpoint
DROP INDEX "ix_ai_chat_messages_school_id";--> statement-breakpoint
ALTER TABLE "ai_extractions" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_extractions" ALTER COLUMN "status" SET DATA TYPE "public"."ai_extraction_status" USING "status"::"public"."ai_extraction_status";--> statement-breakpoint
ALTER TABLE "ai_extractions" ALTER COLUMN "status" SET DEFAULT 'success';--> statement-breakpoint
CREATE INDEX "ix_ai_chat_sessions_school_last_message" ON "ai_chat_sessions" USING btree ("school_id","last_message_at");--> statement-breakpoint
CREATE INDEX "ix_ai_chat_sessions_school_class" ON "ai_chat_sessions" USING btree ("school_id","class_id");--> statement-breakpoint
CREATE INDEX "ix_ai_chat_messages_school_created" ON "ai_chat_messages" USING btree ("school_id","created_at");--> statement-breakpoint
ALTER TABLE "ai_extractions" ADD CONSTRAINT "ck_ai_extractions_hash_on_success" CHECK ("ai_extractions"."status" <> 'success' OR "ai_extractions"."raw_input_hash" IS NOT NULL);
