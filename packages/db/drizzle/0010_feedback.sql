-- F12 (#48-M): feedback テーブル (キミテラス フィードバック、V1 feedback.js 移植)。
--
-- 手書き migration: drizzle-kit generate は meta journal (0000-0003 のみ追跡) のドリフトを
-- 1 ファイルに巻き込むため (teacher_inputs / composite FK 等)、本ドメインの差分のみを切り出して
-- 手書きする (global-setup.ts が path 指定で順次ロードする運用、0009 と同じ方針)。
-- enum の DROP TYPE は発生しない (新規 CREATE TABLE のみ)。
--
-- cross-tenant / system_admin_only。RLS policy + 匿名 INSERT 用 SECURITY DEFINER 関数
-- submit_feedback(...) は migrations/0010_feedback_rls.sql (本 DDL の後に流す)。
-- school_id は任意参照 (テナント分離キーではない)。student_episode は PII を含みうる自由記述
-- (CLAUDE.md ルール4、保存のみ・LLM 非送信、schema/feedback.ts docstring 参照)。
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_name" varchar(200),
	"school_id" uuid,
	"classroom_label" varchar(100),
	"student_reaction" integer NOT NULL,
	"teacher_utility" integer NOT NULL,
	"student_episode" text,
	"improvement" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "ck_feedback_student_reaction" CHECK ("feedback"."student_reaction" BETWEEN 1 AND 5),
	CONSTRAINT "ck_feedback_teacher_utility" CHECK ("feedback"."teacher_utility" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_feedback_submitted_at" ON "feedback" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "ix_feedback_school_id" ON "feedback" USING btree ("school_id");
