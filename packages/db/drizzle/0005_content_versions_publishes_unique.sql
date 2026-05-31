-- #145: content_versions のバージョン採番レース + 多重 active publish ガードを DB レベルで強制する。
-- Drizzle スキーマ (content-versions.ts / publishes.ts) の uniqueIndex 化に対応する DDL。
-- このリポジトリは migration を __tests__/_setup/global-setup.ts の loader (ファイル名ハードコード)
-- で順次適用するため、本ファイルを loader にも登録すること ([[migration-loader-pattern]])。
--
-- M-1: (content_id, version) を UNIQUE 化。既存の非 UNIQUE index を貼り替える。
--      同時 publish/update で max+1 採番が衝突しても重複バージョンを DB が弾く。
DROP INDEX IF EXISTS "ix_content_versions_content_version";--> statement-breakpoint
CREATE UNIQUE INDEX "ux_content_versions_content_version" ON "content_versions" USING btree ("content_id","version");--> statement-breakpoint
-- M-3: 1 content = 最大 1 active publish (unpublished_at IS NULL) を部分 UNIQUE index で強制。
--      閉じた publish (unpublished_at NOT NULL) は対象外なので履歴は何件でも残せる。
CREATE UNIQUE INDEX "ux_publishes_active_per_content" ON "publishes" USING btree ("content_id") WHERE "publishes"."unpublished_at" IS NULL;
