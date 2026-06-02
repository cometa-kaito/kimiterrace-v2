CREATE TYPE "public"."tv_downtime_cause" AS ENUM('unknown', 'reboot', 'network');--> statement-breakpoint
CREATE TABLE "tv_device_downtime" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"school_id" uuid NOT NULL,
	"went_down_at" timestamp with time zone NOT NULL,
	"recovered_at" timestamp with time zone,
	"duration_sec" integer,
	"cause_hint" "tv_downtime_cause",
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "tv_device_downtime" ADD CONSTRAINT "tv_device_downtime_device_id_tv_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."tv_devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tv_device_downtime" ADD CONSTRAINT "tv_device_downtime_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_tv_device_downtime_device" ON "tv_device_downtime" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "ix_tv_device_downtime_school" ON "tv_device_downtime" USING btree ("school_id");