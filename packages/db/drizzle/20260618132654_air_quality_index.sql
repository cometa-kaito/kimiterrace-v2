CREATE TYPE "public"."air_quality_source" AS ENUM('env_soramame', 'jma_uv');--> statement-breakpoint
CREATE TABLE "air_quality_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_code" varchar(16) NOT NULL,
	"area_name" varchar(120),
	"source" "air_quality_source" DEFAULT 'env_soramame' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"forecast_date" date NOT NULL,
	"pm25" integer,
	"pm25_band" varchar(32),
	"oxidant" integer,
	"uv_index" integer,
	"uv_band" varchar(32),
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_air_quality_index_area_source_date" ON "air_quality_index" USING btree ("area_code","source","forecast_date");