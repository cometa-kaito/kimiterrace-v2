import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { vector } from "../_shared/pgvector.js";
import { aiChatSessions } from "./ai-chat-sessions.js";
import { schools } from "./schools.js";

/**
 * F06: 対話セッション内の個別メッセージ。
 *
 * role = user は生徒の質問、assistant は Gemini 応答、system は内部プロンプト。
 *
 * - PII: `content_text` には **PII マスキング後** のテキストのみを保存する（CLAUDE.md ルール 4）。
 *   生徒氏名・住所・電話・保護者名はトークン化（例: "{{STUDENT_001}}"）してから格納すること。
 * - PII: `embedding` は **マスキング後テキスト** から生成する（ADR-007、CLAUDE.md ルール 4）。
 * - `evidence` は assistant メッセージで参照した content_version_id の配列（RAG 引用元）。
 * - `confidence_score` は assistant メッセージの RAG 応答信頼度（ADR-017、0.0〜1.0）。
 *
 * 関連: F06 (docs/requirements/functional/F06-student-qa.md), ADR-007, ADR-017, ADR-019
 */
export const aiChatMessages = pgTable(
  "ai_chat_messages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // FK は (session_id, school_id) の composite で張る (#73、下記 foreignKey 参照)。
    sessionId: uuid("session_id").notNull(),
    // user / assistant / system（将来 tool 等が増えうるため enum ではなく varchar）
    role: varchar("role", { length: 16 }).notNull(),
    // PII: マスキング後のテキストのみ。生 PII を入れない（CLAUDE.md ルール 4）
    contentText: text("content_text").notNull(),
    // PII: マスキング後テキストから生成（ADR-007）
    embedding: vector("embedding"),
    tokenCount: integer("token_count").notNull().default(0),
    // assistant メッセージのみ設定（例: "gemini-1.5-pro-002"）
    modelVersion: varchar("model_version", { length: 64 }),
    // assistant メッセージの RAG 応答信頼度（ADR-017、0.0〜1.0）
    confidenceScore: real("confidence_score"),
    // RAG 引用元 content_version_id の配列等
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    // ADR-019: school_id を先頭に持つ複合インデックス（PR #71 Reviewer M-3）。school 内の時系列取得
    // (ORDER BY created_at DESC) を賄い、bare (school_id) を内包するため旧 ix_..._school_id は廃止。
    ixSchoolCreated: index("ix_ai_chat_messages_school_created").on(t.schoolId, t.createdAt),
    ixSessionCreated: index("ix_ai_chat_messages_session_created").on(t.sessionId, t.createdAt),
    // cross-tenant write 整合を DB 強制 (#73)。session と school_id の一致を composite FK で強制。
    fkSession: foreignKey({
      columns: [t.sessionId, t.schoolId],
      foreignColumns: [aiChatSessions.id, aiChatSessions.schoolId],
      name: "fk_ai_chat_messages_session",
    }).onDelete("cascade"),
  }),
);
