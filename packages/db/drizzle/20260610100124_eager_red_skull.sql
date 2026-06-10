CREATE TABLE "class_visitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"visit_date" date NOT NULL,
	"visitor_name" varchar(100) NOT NULL,
	"affiliation" varchar(100),
	"scheduled_time" varchar(5),
	"purpose" varchar(200),
	"host" varchar(100),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "class_visitors" ADD CONSTRAINT "class_visitors_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_visitors" ADD CONSTRAINT "class_visitors_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_class_visitors_class_date" ON "class_visitors" USING btree ("class_id","visit_date");--> statement-breakpoint
CREATE INDEX "ix_class_visitors_school" ON "class_visitors" USING btree ("school_id");