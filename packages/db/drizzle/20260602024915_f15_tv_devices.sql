CREATE TYPE "public"."tv_alert_state" AS ENUM('ok', 'down');--> statement-breakpoint
CREATE TABLE "tv_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"school_id" uuid NOT NULL,
	"label" varchar(200),
	"grade_id" uuid,
	"department_id" uuid,
	"class_id" uuid,
	"target_mac" varchar(64),
	"signage_url" text,
	"webhook_url" text,
	"schedule_json" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_known_ip" varchar(64),
	"last_boot_at" timestamp with time zone,
	"app_version" varchar(64),
	"monitoring_enabled" boolean DEFAULT true NOT NULL,
	"alert_state" "tv_alert_state" DEFAULT 'ok' NOT NULL,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "tv_devices" ADD CONSTRAINT "tv_devices_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tv_devices" ADD CONSTRAINT "tv_devices_grade_id_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tv_devices" ADD CONSTRAINT "tv_devices_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tv_devices" ADD CONSTRAINT "tv_devices_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_tv_devices_device_id" ON "tv_devices" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "ix_tv_devices_school" ON "tv_devices" USING btree ("school_id");