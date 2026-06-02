CREATE TYPE "public"."tv_command_status" AS ENUM('pending', 'delivered', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."tv_command_type" AS ENUM('signage_reload', 'signage_open', 'signage_exit', 'service_restart');--> statement-breakpoint
CREATE TABLE "tv_device_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"school_id" uuid NOT NULL,
	"command" "tv_command_type" NOT NULL,
	"params_json" jsonb,
	"status" "tv_command_status" DEFAULT 'pending' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "tv_device_commands" ADD CONSTRAINT "tv_device_commands_device_id_tv_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."tv_devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tv_device_commands" ADD CONSTRAINT "tv_device_commands_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_tv_device_commands_device_status" ON "tv_device_commands" USING btree ("device_id","status");--> statement-breakpoint
CREATE INDEX "ix_tv_device_commands_school" ON "tv_device_commands" USING btree ("school_id");