-- #154 (item: token 使用量の記録): ai_extractions にトークン使用量列を追加。
--
-- F03 受け入れ条件「token 数が記録される」を満たす。生プロンプト/応答は保存せず（ルール4）、
-- 集計値（PII を含まない）として promptTokens / completionTokens / totalTokens を保持。
-- 既存行および rate-limit / PII-leak でモデル未到達のケース向けに DEFAULT 0、NOT NULL で
-- 欠落を機械排除する（toAiExtractionInsert は ModelUsage を必ず写像する）。
ALTER TABLE "ai_extractions" ADD COLUMN "prompt_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_extractions" ADD COLUMN "completion_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_extractions" ADD COLUMN "total_tokens" integer DEFAULT 0 NOT NULL;