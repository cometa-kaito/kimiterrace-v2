CREATE TABLE "student_callouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"callout_date" date NOT NULL,
	"student_name" varchar(100) NOT NULL,
	"location" varchar(100),
	"reason" varchar(200),
	"scheduled_time" varchar(5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "student_callouts" ADD CONSTRAINT "student_callouts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_callouts" ADD CONSTRAINT "student_callouts_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_student_callouts_class_date" ON "student_callouts" USING btree ("class_id","callout_date");--> statement-breakpoint
CREATE INDEX "ix_student_callouts_school" ON "student_callouts" USING btree ("school_id");