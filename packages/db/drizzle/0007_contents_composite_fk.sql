-- #204 (#73 横展開): contents ドメインの cross-tenant write 整合を composite FK で DB 強制。
-- #203 (AI/RAG) と同方針。RLS は read を守るが write のテナント混在を守らないため、
-- content_versions / publishes が別テナントの contents / content_versions を指す行を弾く。
-- 親に UNIQUE(id, school_id) を置き、子 FK を (fk列, school_id) → 親(id, school_id) に張り替える。
--
-- schema 単一ソース: packages/db/src/schema/{contents,content-versions,publishes}.ts を更新済
-- (ルール3)。drizzle meta drift (#195) のため generate 不使用で手書きし loader に登録。

-- 1) 既存の単純 FK を外す (baseline 0000 の drizzle 自動命名)。
ALTER TABLE "content_versions" DROP CONSTRAINT IF EXISTS "content_versions_content_id_contents_id_fk";--> statement-breakpoint
ALTER TABLE "publishes" DROP CONSTRAINT IF EXISTS "publishes_content_id_contents_id_fk";--> statement-breakpoint
ALTER TABLE "publishes" DROP CONSTRAINT IF EXISTS "publishes_version_id_content_versions_id_fk";--> statement-breakpoint

-- 2) 親に composite FK のターゲット UNIQUE(id, school_id) を追加。
ALTER TABLE "contents" ADD CONSTRAINT "uq_contents_id_school" UNIQUE ("id","school_id");--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "uq_content_versions_id_school" UNIQUE ("id","school_id");--> statement-breakpoint

-- 3) composite FK を張る。ON DELETE は既存挙動を踏襲 (content=cascade, version=restrict)。
ALTER TABLE "content_versions" ADD CONSTRAINT "fk_content_versions_content" FOREIGN KEY ("content_id","school_id") REFERENCES "public"."contents"("id","school_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishes" ADD CONSTRAINT "fk_publishes_content" FOREIGN KEY ("content_id","school_id") REFERENCES "public"."contents"("id","school_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishes" ADD CONSTRAINT "fk_publishes_version" FOREIGN KEY ("version_id","school_id") REFERENCES "public"."content_versions"("id","school_id") ON DELETE restrict ON UPDATE no action;
