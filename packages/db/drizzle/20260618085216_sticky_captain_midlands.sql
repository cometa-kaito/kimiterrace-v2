CREATE TYPE "public"."news_source" AS ENUM('jst', 'mext', 'meti');--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "news_source" NOT NULL,
	"source_label" varchar(120) NOT NULL,
	"title" varchar(300) NOT NULL,
	"url" text NOT NULL,
	"category" varchar(32),
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_news_items_source_url" ON "news_items" USING btree ("source","url");