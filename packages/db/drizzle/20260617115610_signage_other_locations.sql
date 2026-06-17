ALTER TABLE "classes" ALTER COLUMN "grade" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_classes_department" ON "classes" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_classes_school_dept_other_name" ON "classes" USING btree ("school_id","department_id","name") WHERE "classes"."grade_id" IS NULL;