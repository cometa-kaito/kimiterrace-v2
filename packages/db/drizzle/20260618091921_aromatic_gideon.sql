CREATE TYPE "public"."warning_level" AS ENUM('none', 'advisory', 'warning', 'emergency');--> statement-breakpoint
CREATE TABLE "weather_warnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_code" varchar(16) NOT NULL,
	"area_name" varchar(120),
	"source" "weather_source" DEFAULT 'jma' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"report_datetime" timestamp with time zone,
	"headline" text,
	"max_level" "warning_level" DEFAULT 'none' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_weather_warnings_area_source" ON "weather_warnings" USING btree ("area_code","source");