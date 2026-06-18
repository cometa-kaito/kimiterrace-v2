CREATE TYPE "public"."snippet_category" AS ENUM('quote', 'idiom', 'word', 'on_this_day');--> statement-breakpoint
CREATE TABLE "signage_snippets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "snippet_category" NOT NULL,
	"body" text NOT NULL,
	"reading" varchar(200),
	"meaning" text,
	"attribution" varchar(200),
	"month_day" varchar(5),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_signage_snippets_category_body" ON "signage_snippets" USING btree ("category","body");