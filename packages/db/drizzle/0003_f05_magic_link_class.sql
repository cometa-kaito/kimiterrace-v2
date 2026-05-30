ALTER TABLE "magic_links" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '90 days';--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "class_id" uuid;--> statement-breakpoint
ALTER TABLE "magic_links" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_magic_links_class_id" ON "magic_links" USING btree ("class_id");