CREATE TYPE "public"."heat_alert_level" AS ENUM('none', 'warning', 'emergency');--> statement-breakpoint
CREATE TYPE "public"."heat_source" AS ENUM('env_moe');--> statement-breakpoint
CREATE TYPE "public"."wbgt_band" AS ENUM('almost_safe', 'caution', 'warning', 'severe', 'danger');--> statement-breakpoint
CREATE TABLE "heat_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_code" varchar(16) NOT NULL,
	"area_name" varchar(120),
	"source" "heat_source" DEFAULT 'env_moe' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"forecast_date" date NOT NULL,
	"alert_level" "heat_alert_level" DEFAULT 'none' NOT NULL,
	"wbgt_max" integer,
	"wbgt_band" "wbgt_band",
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_heat_alerts_area_source_date" ON "heat_alerts" USING btree ("area_code","source","forecast_date");