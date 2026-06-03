CREATE TYPE "public"."advertiser_status" AS ENUM('prospect', 'active', 'paused');--> statement-breakpoint
ALTER TABLE "advertisers" ADD COLUMN "status" "advertiser_status" DEFAULT 'prospect' NOT NULL;--> statement-breakpoint
-- F10 (#46, PR #534): 既存行を is_active から backfill する。ADD COLUMN の既定 'prospect' は新規行用で、
-- 既存行は稼働中=active / 停止=paused に上書きして不変条件 (status='paused' ⟺ is_active=false /
-- status∈{prospect,active} ⟺ is_active=true) を確立する。add column → backfill の順。
UPDATE "advertisers" SET "status" = CASE WHEN "is_active" THEN 'active' ELSE 'paused' END;--> statement-breakpoint
CREATE INDEX "ix_advertisers_status" ON "advertisers" USING btree ("status");