ALTER TABLE "classes" ADD COLUMN "grade_id" uuid;--> statement-breakpoint
ALTER TABLE "grades" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_grade_id_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grades" ADD CONSTRAINT "grades_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_classes_grade" ON "classes" USING btree ("grade_id");--> statement-breakpoint
CREATE INDEX "ix_grades_department" ON "grades" USING btree ("department_id");