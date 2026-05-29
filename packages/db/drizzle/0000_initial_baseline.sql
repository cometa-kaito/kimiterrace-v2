CREATE TYPE "public"."user_role" AS ENUM('school_admin', 'teacher', 'student', 'guardian');--> statement-breakpoint
CREATE TYPE "public"."publish_scope" AS ENUM('school', 'class', 'homeroom', 'private');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('view', 'tap', 'dwell', 'ask');--> statement-breakpoint
CREATE TYPE "public"."ai_extraction_kind" AS ENUM('schedule', 'announcement', 'summary', 'tag');--> statement-breakpoint
CREATE TYPE "public"."audit_op" AS ENUM('insert', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'active', 'paused', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."communication_channel" AS ENUM('email', 'phone', 'meeting', 'other');--> statement-breakpoint
CREATE TABLE "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"prefecture" varchar(32) NOT NULL,
	"code" varchar(32),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"identity_uid" varchar(128) NOT NULL,
	"role" "user_role" NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"email" varchar(320),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"academic_year" integer NOT NULL,
	"name" varchar(64) NOT NULL,
	"grade" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"membership_role" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"title" varchar(300) NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"publish_scope" "publish_scope" NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"embedding" vector(768),
	"diff_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "publishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unpublished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" uuid,
	"content_id" uuid,
	"type" "event_type" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"content_id" uuid,
	"extraction_kind" "ai_extraction_kind" NOT NULL,
	"confidence_score" real NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_input_hash" varchar(64),
	"model_version" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'success' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"magic_link_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"rate_limit_window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"rate_limit_count" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content_text" text NOT NULL,
	"embedding" vector(768),
	"token_count" integer DEFAULT 0 NOT NULL,
	"model_version" varchar(64),
	"confidence_score" real,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "advertisers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" varchar(200) NOT NULL,
	"industry" varchar(100),
	"contact_email" varchar(320),
	"contact_phone" varchar(50),
	"address" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advertiser_id" uuid NOT NULL,
	"status" "contract_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"monthly_fee_jpy" integer NOT NULL,
	"target_schools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advertiser_id" uuid NOT NULL,
	"contract_id" uuid,
	"channel" "communication_channel" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"subject" varchar(300) NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"attachments_json" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "monthly_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"target_year" integer NOT NULL,
	"target_month" integer NOT NULL,
	"pdf_storage_path" varchar(500) NOT NULL,
	"pdf_size_bytes" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metrics_snapshot" jsonb NOT NULL,
	"ai_commentary" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "system_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_uid" varchar(128) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"email" varchar(320) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_identity_uid" varchar(128),
	"school_id" uuid,
	"table_name" varchar(64) NOT NULL,
	"record_id" uuid,
	"operation" "audit_op" NOT NULL,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"prev_hash" varchar(64),
	"row_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishes" ADD CONSTRAINT "publishes_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishes" ADD CONSTRAINT "publishes_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishes" ADD CONSTRAINT "publishes_version_id_content_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extractions" ADD CONSTRAINT "ai_extractions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_extractions" ADD CONSTRAINT "ai_extractions_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_magic_link_id_magic_links_id_fk" FOREIGN KEY ("magic_link_id") REFERENCES "public"."magic_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_session_id_ai_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_advertiser_id_advertisers_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."advertisers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_advertiser_id_advertisers_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."advertisers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_users_identity_uid" ON "users" USING btree ("identity_uid");--> statement-breakpoint
CREATE INDEX "ix_users_school_id" ON "users" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_classes_school_year" ON "classes" USING btree ("school_id","academic_year");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_memberships_class_user" ON "memberships" USING btree ("class_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_magic_links_token_hash" ON "magic_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_magic_links_school_id" ON "magic_links" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_contents_school_id" ON "contents" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_contents_status" ON "contents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_content_versions_content_version" ON "content_versions" USING btree ("content_id","version");--> statement-breakpoint
CREATE INDEX "ix_publishes_content" ON "publishes" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "ix_events_school_time" ON "events" USING btree ("school_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_ai_extractions_school_id" ON "ai_extractions" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_ai_extractions_content_id" ON "ai_extractions" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "ix_ai_extractions_status" ON "ai_extractions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_ai_chat_sessions_school_id" ON "ai_chat_sessions" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_ai_chat_sessions_magic_link_id" ON "ai_chat_sessions" USING btree ("magic_link_id");--> statement-breakpoint
CREATE INDEX "ix_ai_chat_sessions_last_message_at" ON "ai_chat_sessions" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "ix_ai_chat_messages_school_id" ON "ai_chat_messages" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_ai_chat_messages_session_created" ON "ai_chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_advertisers_company_name" ON "advertisers" USING btree ("company_name");--> statement-breakpoint
CREATE INDEX "ix_advertisers_is_active" ON "advertisers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "ix_contracts_advertiser_id" ON "contracts" USING btree ("advertiser_id");--> statement-breakpoint
CREATE INDEX "ix_contracts_status" ON "contracts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_contracts_started_at" ON "contracts" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "ix_communications_advertiser_id" ON "communications" USING btree ("advertiser_id");--> statement-breakpoint
CREATE INDEX "ix_communications_occurred_at" ON "communications" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ix_communications_channel" ON "communications" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "ix_monthly_reports_school_id" ON "monthly_reports" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_monthly_reports_year_month" ON "monthly_reports" USING btree ("target_year","target_month");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_monthly_reports_school_year_month" ON "monthly_reports" USING btree ("school_id","target_year","target_month");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_system_admins_identity_uid" ON "system_admins" USING btree ("identity_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_system_admins_email" ON "system_admins" USING btree ("email");--> statement-breakpoint
CREATE INDEX "ix_system_admins_is_active" ON "system_admins" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "ix_audit_log_occurred_at" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ix_audit_log_table_record" ON "audit_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "ix_audit_log_actor_user_id" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "ix_audit_log_school_id" ON "audit_log" USING btree ("school_id");