-- #73 (PR #71 H-1): cross-tenant write 整合を DB レベルで強制する composite FK。
-- RLS は read を守るが write のテナント混在は守らない。アプリ層バグや stale session context で
-- 別テナントの magic_link / class / session を指す行が書かれると、BYPASSRLS 経路では検知できず
-- テナント混在 (STRIDE EoP) になる。親に UNIQUE(id, school_id) を置き、子の FK を
-- (fk列, school_id) → 親(id, school_id) の composite に張り替えて school_id 一致を DB 強制する。
-- スコープは PR #71 H-1 の AI/RAG チェーン (ai_chat_sessions / ai_chat_messages)。
-- contents / publishes / events 等への横展開は別 follow-up (ルール6)。
--
-- schema 単一ソース: packages/db/src/schema/{ai-chat-sessions,ai-chat-messages,classes,magic-links}.ts
-- を composite FK / unique 構文に更新済 (ルール3)。drizzle meta drift (#195) のため generate は
-- 使わず本ファイルを手書きし loader (global-setup.ts) に登録する。

-- 1) 既存の単純 FK を外す (baseline 0000 の drizzle 自動命名)。
ALTER TABLE "ai_chat_sessions" DROP CONSTRAINT IF EXISTS "ai_chat_sessions_magic_link_id_magic_links_id_fk";--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" DROP CONSTRAINT IF EXISTS "ai_chat_sessions_class_id_classes_id_fk";--> statement-breakpoint
ALTER TABLE "ai_chat_messages" DROP CONSTRAINT IF EXISTS "ai_chat_messages_session_id_ai_chat_sessions_id_fk";--> statement-breakpoint

-- 2) 親に composite FK のターゲット UNIQUE(id, school_id) を追加 (id は PK で単独 unique だが
--    composite FK の参照先には (id, school_id) の UNIQUE/PK が必要)。
ALTER TABLE "magic_links" ADD CONSTRAINT "uq_magic_links_id_school" UNIQUE ("id","school_id");--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "uq_classes_id_school" UNIQUE ("id","school_id");--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "uq_ai_chat_sessions_id_school" UNIQUE ("id","school_id");--> statement-breakpoint

-- 3) composite FK を張る。ON DELETE は既存挙動を踏襲 (magic_link/session=cascade, class=restrict)。
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "fk_ai_chat_sessions_magic_link" FOREIGN KEY ("magic_link_id","school_id") REFERENCES "public"."magic_links"("id","school_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "fk_ai_chat_sessions_class" FOREIGN KEY ("class_id","school_id") REFERENCES "public"."classes"("id","school_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "fk_ai_chat_messages_session" FOREIGN KEY ("session_id","school_id") REFERENCES "public"."ai_chat_sessions"("id","school_id") ON DELETE cascade ON UPDATE no action;
