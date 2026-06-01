CREATE TABLE "ai_rate_limit_windows" (
	"school_id" uuid NOT NULL,
	"window_start_ms" bigint NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "ai_rate_limit_windows_school_id_window_start_ms_pk" PRIMARY KEY("school_id","window_start_ms"),
	CONSTRAINT "ck_ai_rate_limit_windows_count_nonneg" CHECK ("ai_rate_limit_windows"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_rate_limit_windows" ADD CONSTRAINT "ai_rate_limit_windows_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;