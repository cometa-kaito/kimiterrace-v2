CREATE TABLE "ad_target_monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"school_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "uq_ad_target_monitors_ad_monitor" UNIQUE("ad_id","monitor_id")
);
--> statement-breakpoint
ALTER TABLE "ads" DROP CONSTRAINT "ck_ads_scope";--> statement-breakpoint
ALTER TABLE "ad_target_monitors" ADD CONSTRAINT "ad_target_monitors_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_target_monitors" ADD CONSTRAINT "ad_target_monitors_monitor_id_tv_devices_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."tv_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_target_monitors" ADD CONSTRAINT "ad_target_monitors_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ad_target_monitors_ad_id" ON "ad_target_monitors" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "ix_ad_target_monitors_monitor_id" ON "ad_target_monitors" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "ix_ad_target_monitors_school_id" ON "ad_target_monitors" USING btree ("school_id");--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ck_ads_scope" CHECK ((
        ("ads"."scope" = 'school' AND "ads"."grade_id" IS NULL AND "ads"."class_id" IS NULL AND "ads"."department_id" IS NULL)
        OR ("ads"."scope" = 'grade' AND "ads"."grade_id" IS NOT NULL AND "ads"."class_id" IS NULL)
        OR ("ads"."scope" = 'department' AND "ads"."department_id" IS NOT NULL AND "ads"."grade_id" IS NULL AND "ads"."class_id" IS NULL)
        OR ("ads"."scope" = 'class' AND "ads"."class_id" IS NOT NULL)
        OR ("ads"."scope" = 'monitor' AND "ads"."grade_id" IS NULL AND "ads"."class_id" IS NULL AND "ads"."department_id" IS NULL)
      ));