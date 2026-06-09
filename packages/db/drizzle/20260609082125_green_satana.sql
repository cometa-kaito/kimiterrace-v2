CREATE TYPE "public"."tv_provisioning_status" AS ENUM('pending', 'claimed', 'preflight', 'awaiting_physical', 'provisioning', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "tv_provisioning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"class_id" uuid,
	"tv_device_row_id" uuid,
	"device_id" text,
	"target_ip" text,
	"status" "tv_provisioning_status" DEFAULT 'pending' NOT NULL,
	"current_step" text,
	"steps_json" jsonb,
	"signage_url" text,
	"schedule_json" jsonb,
	"target_mac" varchar(32),
	"error" text,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "tv_provisioning_jobs" ADD CONSTRAINT "tv_provisioning_jobs_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tv_provisioning_jobs" ADD CONSTRAINT "tv_provisioning_jobs_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tv_provisioning_jobs" ADD CONSTRAINT "tv_provisioning_jobs_tv_device_row_id_tv_devices_id_fk" FOREIGN KEY ("tv_device_row_id") REFERENCES "public"."tv_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_tv_provisioning_jobs_status" ON "tv_provisioning_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_tv_provisioning_jobs_school" ON "tv_provisioning_jobs" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "ix_tv_provisioning_jobs_device" ON "tv_provisioning_jobs" USING btree ("device_id");