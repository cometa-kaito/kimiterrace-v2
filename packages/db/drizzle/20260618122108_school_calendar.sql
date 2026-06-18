CREATE TABLE "school_calendar_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"ics_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "school_calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"uid" varchar(512) NOT NULL,
	"summary" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"location" varchar(512),
	"source_id" uuid,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "ux_school_calendar_events_school_uid" UNIQUE("school_id","uid")
);
--> statement-breakpoint
ALTER TABLE "school_calendar_sources" ADD CONSTRAINT "school_calendar_sources_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_calendar_events" ADD CONSTRAINT "school_calendar_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_calendar_events" ADD CONSTRAINT "school_calendar_events_source_id_school_calendar_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."school_calendar_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_school_calendar_sources_school" ON "school_calendar_sources" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_school_calendar_sources_enabled" ON "school_calendar_sources" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "ix_school_calendar_events_school_start" ON "school_calendar_events" USING btree ("school_id","start_date");