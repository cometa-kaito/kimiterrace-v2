import { sql } from "drizzle-orm";
import {
  customType,
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
import { aiChatSessions } from "./ai-chat-sessions.js";
import { schools } from "./schools.js";

// pgvector の vector 型を Drizzle に教える（次元 768 = Gemini text-embedding-004）。
// 既存 content-versions.ts の customType パターンを踏襲（ADR-007）。
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(768)";
  },
});

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
    sessionId: uuid("session_id")
      .notNull()
      .references(() => aiChatSessions.id, { onDelete: "cascade" }),
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
    ixSchool: index("ix_ai_chat_messages_school_id").on(t.schoolId),
    ixSessionCreated: index("ix_ai_chat_messages_session_created").on(t.sessionId, t.createdAt),
  }),
);
