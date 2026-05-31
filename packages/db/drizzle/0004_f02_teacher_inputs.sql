-- =====================================================================
-- 0003_f02_teacher_inputs.sql
-- 目的: F02 教員音声 / チャット入力テーブル + 添付メタテーブルの DDL。
--
-- 対象テーブル (いずれも school_id を持つテナント分離テーブル):
--   teacher_inputs / teacher_input_attachments
--
-- enum: teacher_input_type / teacher_input_status
--   既存 baseline の enum 生成と同様、duplicate_object ガードで冪等にする。
--
-- 監査カラム (created_at/updated_at/created_by/updated_by) は全テーブルに付与
-- (CLAUDE.md ルール1)。created_by/updated_by の users(id) FK は migrations/0008 で
-- 後付け (src/_shared/audit.ts が循環依存回避で FK 未宣言のため、既存 0004/0006 と同パターン)。
--
-- RLS policy は migrations/0009_f02_schema_rls.sql で貼る。
-- global-setup.ts の loader 配列にも本ファイル + 0008 を登録すること。
-- =====================================================================

-- ---------------------------------------------------------------------
-- enum (冪等)
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "teacher_input_type" AS ENUM ('voice', 'chat');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "teacher_input_status" AS ENUM ('draft', 'transcribing', 'ready', 'submitted');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- teacher_inputs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "teacher_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "school_id" uuid NOT NULL,
  "teacher_id" uuid,
  "input_type" "teacher_input_type" NOT NULL,
  "status" "teacher_input_status" DEFAULT 'draft' NOT NULL,
  "audio_path" text,
  "transcript" text,
  "transcript_edited" boolean DEFAULT false NOT NULL,
  "submitted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_by" uuid
);
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- teacher_input_attachments
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "teacher_input_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "school_id" uuid NOT NULL,
  "input_id" uuid NOT NULL,
  "storage_path" text NOT NULL,
  "mime_type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_by" uuid
);
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- FK (school_id / teacher_id / input_id)
-- ---------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "teacher_inputs"
    ADD CONSTRAINT "teacher_inputs_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "teacher_inputs"
    ADD CONSTRAINT "teacher_inputs_teacher_id_users_id_fk"
    FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "teacher_input_attachments"
    ADD CONSTRAINT "teacher_input_attachments_school_id_schools_id_fk"
    FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "teacher_input_attachments"
    ADD CONSTRAINT "teacher_input_attachments_input_id_teacher_inputs_id_fk"
    FOREIGN KEY ("input_id") REFERENCES "teacher_inputs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- index (school_id / teacher_id / status / input_id)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "ix_teacher_inputs_school_id" ON "teacher_inputs" ("school_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_teacher_inputs_teacher_id" ON "teacher_inputs" ("teacher_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_teacher_inputs_status" ON "teacher_inputs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_teacher_input_attachments_school_id" ON "teacher_input_attachments" ("school_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_teacher_input_attachments_input_id" ON "teacher_input_attachments" ("input_id");
