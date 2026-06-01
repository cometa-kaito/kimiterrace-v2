CREATE TYPE "public"."sensor_kind" AS ENUM('presence_pir');--> statement-breakpoint
CREATE TYPE "public"."sensor_vendor" AS ENUM('switchbot');--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE 'presence';--> statement-breakpoint
CREATE TABLE "sensor_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"device_mac" varchar(64) NOT NULL,
	"device_id_external" varchar(128),
	"vendor" "sensor_vendor" DEFAULT 'switchbot' NOT NULL,
	"kind" "sensor_kind" DEFAULT 'presence_pir' NOT NULL,
	"location_label" varchar(120),
	"class_id" uuid,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decommissioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "sensor_devices" ADD CONSTRAINT "sensor_devices_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sensor_devices" ADD CONSTRAINT "sensor_devices_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_sensor_devices_device_mac" ON "sensor_devices" USING btree ("device_mac");--> statement-breakpoint
CREATE INDEX "ix_sensor_devices_school" ON "sensor_devices" USING btree ("school_id");