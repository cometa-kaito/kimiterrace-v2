CREATE TYPE "public"."weather_source" AS ENUM('jma');--> statement-breakpoint
CREATE TABLE "weather_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_code" varchar(16) NOT NULL,
	"area_name" varchar(120),
	"source" "weather_source" DEFAULT 'jma' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"forecast_date" date NOT NULL,
	"weather_code" varchar(8),
	"weather_text" varchar(120),
	"temp_min" integer,
	"temp_max" integer,
	"pop" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_weather_forecasts_area_source_date" ON "weather_forecasts" USING btree ("area_code","source","forecast_date");