ALTER TABLE "ai_chat_sessions" ALTER COLUMN "magic_link_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ALTER COLUMN "class_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ai_chat_sessions_school_user" ON "ai_chat_sessions" USING btree ("school_id","user_id");--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ck_ai_chat_sessions_identity" CHECK (("ai_chat_sessions"."magic_link_id" IS NOT NULL) <> ("ai_chat_sessions"."user_id" IS NOT NULL));