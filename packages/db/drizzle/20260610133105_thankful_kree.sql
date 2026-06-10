CREATE TABLE "railway_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator" varchar(32) NOT NULL,
	"operator_name" varchar(64),
	"has_disruption" boolean DEFAULT false NOT NULL,
	"status_text" varchar(500) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_railway_status_operator" ON "railway_status" USING btree ("operator");