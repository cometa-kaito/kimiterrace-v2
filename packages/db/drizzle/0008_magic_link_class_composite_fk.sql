-- #204 (#73 横展開、最終): magic_links.class_id を composite FK 化し cross-tenant write 整合を
-- DB 強制する。別テナントの class を指すクラスリンクの発行を弾く (#203/#207 と同方針)。
-- classes には uq_classes_id_school (#203 / 0006) が既にあるため参照先 UNIQUE は追加不要。
--
-- class_id は nullable (旧・保護者単回リンクは NULL)。MATCH SIMPLE のため class_id NULL の行は
-- FK 検査をスキップする (クラス紐付けが無いので検査対象外)。class_id が入る F05 クラスリンクのみ
-- (class_id, school_id) の一致を強制。
--
-- schema 単一ソース: packages/db/src/schema/magic-links.ts を foreignKey() に更新済 (ルール3)。
-- drizzle meta drift (#195) のため generate 不使用で手書きし loader (global-setup.ts) に登録。

-- 1) 既存の単純 FK を外す (F05 0003 の drizzle 自動命名)。
ALTER TABLE "magic_links" DROP CONSTRAINT IF EXISTS "magic_links_class_id_classes_id_fk";--> statement-breakpoint
-- 2) composite FK を張る (ON DELETE cascade は既存踏襲)。
ALTER TABLE "magic_links" ADD CONSTRAINT "fk_magic_links_class" FOREIGN KEY ("class_id","school_id") REFERENCES "public"."classes"("id","school_id") ON DELETE cascade ON UPDATE no action;
