CREATE TABLE "class_weekly_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"schedule_by_weekday" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "ux_class_weekly_schedules_class" UNIQUE("class_id")
);
--> statement-breakpoint
-- （手動除去）drizzle-kit は class_visitors / student_callouts の sort_order ADD COLUMN もここに生成したが、
-- それらは手書き 0034/0035（ADD COLUMN IF NOT EXISTS・適用済み環境あり）が担うため本ファイルからは除去した。
-- スナップショット（meta）には sort_order が取り込まれたので、以後の generate で再出力されるドリフトは解消済み。

ALTER TABLE "class_weekly_schedules" ADD CONSTRAINT "class_weekly_schedules_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_weekly_schedules" ADD CONSTRAINT "class_weekly_schedules_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_class_weekly_schedules_school" ON "class_weekly_schedules" USING btree ("school_id");