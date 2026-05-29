import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, real, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { aiExtractionKind } from "../_shared/enums.js";
import { contents } from "./contents.js";
import { schools } from "./schools.js";

/**
 * F03: AI 構造化抽出の監査テーブル。
 *
 * Vertex AI Gemini で抽出した結果（時間割・お知らせ・要約・タグ）と、その信頼度・根拠・
 * モデルバージョンを記録する。再現性・障害分析・PII 漏洩追跡のため、入力テキストは
 * **PII マスキング後** の SHA-256 ハッシュのみ保存（生テキストは保存しない）。
 *
 * 関連: ADR-007 (pgvector), ADR-017 (Gemini + confidence_score), ADR-019 (RLS),
 *       F03 (docs/requirements/functional/F03-ai-structuring.md)
 */
export const aiExtractions = pgTable(
  "ai_extractions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 抽出元 content。抽出時点で content がまだ確定していないケース（事前バッチ等）は null。
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "set null" }),
    extractionKind: aiExtractionKind("extraction_kind").notNull(),
    // ADR-017 必須: 抽出結果の信頼度（0.0〜1.0）
    confidenceScore: real("confidence_score").notNull(),
    // 抽出根拠の引用箇所配列（例: [{page, span, text}, ...]）
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    // PII マスキング後の入力テキスト SHA-256（生テキストは保存しない）
    rawInputHash: varchar("raw_input_hash", { length: 64 }),
    // 例: "gemini-1.5-pro-002"
    modelVersion: varchar("model_version", { length: 64 }).notNull(),
    // success / retry / failed
    status: varchar("status", { length: 32 }).notNull().default("success"),
    errorMessage: text("error_message"),
    ...auditColumns,
  },
  (t) => ({
    ixSchool: index("ix_ai_extractions_school_id").on(t.schoolId),
    ixContent: index("ix_ai_extractions_content_id").on(t.contentId),
    ixStatus: index("ix_ai_extractions_status").on(t.status),
  }),
);
