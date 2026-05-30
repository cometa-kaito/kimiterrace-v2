CREATE TYPE "public"."ad_media_type" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."config_kind" AS ENUM('display_settings', 'quiet_hours', 'schedule_templates');--> statement-breakpoint
CREATE TYPE "public"."hierarchy_scope" AS ENUM('school', 'grade', 'class', 'department');--> statement-breakpoint
CREATE TABLE "grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"has_classes" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "school_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"scope" "hierarchy_scope" NOT NULL,
	"grade_id" uuid,
	"department_id" uuid,
	"class_id" uuid,
	"kind" "config_kind" NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "ux_school_configs_target" UNIQUE NULLS NOT DISTINCT("school_id","scope","grade_id","department_id","class_id","kind"),
	CONSTRAINT "ck_school_configs_scope" CHECK ((
        ("school_configs"."scope" = 'school' AND "school_configs"."grade_id" IS NULL AND "school_configs"."class_id" IS NULL AND "school_configs"."department_id" IS NULL)
        OR ("school_configs"."scope" = 'grade' AND "school_configs"."grade_id" IS NOT NULL AND "school_configs"."class_id" IS NULL)
        OR ("school_configs"."scope" = 'department' AND "school_configs"."department_id" IS NOT NULL AND "school_configs"."grade_id" IS NULL AND "school_configs"."class_id" IS NULL)
        OR ("school_configs"."scope" = 'class' AND "school_configs"."class_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "daily_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"scope" "hierarchy_scope" NOT NULL,
	"grade_id" uuid,
	"department_id" uuid,
	"class_id" uuid,
	"date" date NOT NULL,
	"schedules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quiet_hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "ux_daily_data_target_date" UNIQUE NULLS NOT DISTINCT("school_id","scope","grade_id","department_id","class_id","date"),
	CONSTRAINT "ck_daily_data_scope" CHECK ((
        ("daily_data"."scope" = 'school' AND "daily_data"."grade_id" IS NULL AND "daily_data"."class_id" IS NULL AND "daily_data"."department_id" IS NULL)
        OR ("daily_data"."scope" = 'grade' AND "daily_data"."grade_id" IS NOT NULL AND "daily_data"."class_id" IS NULL)
        OR ("daily_data"."scope" = 'department' AND "daily_data"."department_id" IS NOT NULL AND "daily_data"."grade_id" IS NULL AND "daily_data"."class_id" IS NULL)
        OR ("daily_data"."scope" = 'class' AND "daily_data"."class_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"scope" "hierarchy_scope" NOT NULL,
	"grade_id" uuid,
	"department_id" uuid,
	"class_id" uuid,
	"media_url" text NOT NULL,
	"media_type" "ad_media_type" NOT NULL,
	"duration_sec" integer DEFAULT 5 NOT NULL,
	"link_url" text,
	"caption" varchar(60),
	"caption_font_scale" real DEFAULT 1 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "ck_ads_scope" CHECK ((
        ("ads"."scope" = 'school' AND "ads"."grade_id" IS NULL AND "ads"."class_id" IS NULL AND "ads"."department_id" IS NULL)
        OR ("ads"."scope" = 'grade' AND "ads"."grade_id" IS NOT NULL AND "ads"."class_id" IS NULL)
        OR ("ads"."scope" = 'department' AND "ads"."department_id" IS NOT NULL AND "ads"."grade_id" IS NULL AND "ads"."class_id" IS NULL)
        OR ("ads"."scope" = 'class' AND "ads"."class_id" IS NOT NULL)
      )),
	CONSTRAINT "ck_ads_duration_positive" CHECK ("ads"."duration_sec" > 0)
);
--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_configs" ADD CONSTRAINT "school_configs_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_configs" ADD CONSTRAINT "school_configs_grade_id_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_configs" ADD CONSTRAINT "school_configs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_configs" ADD CONSTRAINT "school_configs_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_data" ADD CONSTRAINT "daily_data_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_data" ADD CONSTRAINT "daily_data_grade_id_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_data" ADD CONSTRAINT "daily_data_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_data" ADD CONSTRAINT "daily_data_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_grade_id_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_grades_school_name" ON "grades" USING btree ("school_id","name");--> statement-breakpoint
CREATE INDEX "ix_grades_school_order" ON "grades" USING btree ("school_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_departments_school_name" ON "departments" USING btree ("school_id","name");--> statement-breakpoint
CREATE INDEX "ix_departments_school_order" ON "departments" USING btree ("school_id","display_order");--> statement-breakpoint
CREATE INDEX "ix_daily_data_school_date" ON "daily_data" USING btree ("school_id","date");--> statement-breakpoint
CREATE INDEX "ix_ads_target_order" ON "ads" USING btree ("school_id","scope","display_order");