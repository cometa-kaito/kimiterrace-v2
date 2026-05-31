import { sql } from "drizzle-orm";
import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schools } from "./schools.js";
import { teacherInputs } from "./teacher-inputs.js";

/**
 * F02 (FR-05): 教員入力に添付したファイルのメタ行。
 *
 * **本スライスのスコープはメタ行のみ**。実際のアップロード・Cloud Storage 署名付き URL の
 * 発行・バイナリ転送は本 PR に含めない (TODO 参照)。クライアントは別経路で Cloud Storage に
 * アップロードし、その `storage_path` を本テーブルに登録する。
 *
 * **テナント分離 (RLS 対象)**: `school_id` を持つ。0009_f02_schema_rls.sql で policy を貼る。
 * 親 `teacher_inputs` 削除時は cascade で添付メタも消す。
 *
 * TODO(添付実体): Cloud Storage 署名付き URL 発行・実アップロード・MIME 検証・ウイルススキャンは
 *   別 PR。本テーブルは「どの入力に / どこに / 何の種類のファイルがあるか」のメタのみを持つ。
 *
 * 関連: F02 FR-05, ADR-019 (RLS)
 */
export const teacherInputAttachments = pgTable(
  "teacher_input_attachments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    inputId: uuid("input_id")
      .notNull()
      .references(() => teacherInputs.id, { onDelete: "cascade" }),
    // Cloud Storage object のフルパス (バケット名込み想定。クライアントから受領)。
    storagePath: text("storage_path").notNull(),
    mimeType: text("mime_type").notNull(),
    ...auditColumns,
  },
  (t) => ({
    ixSchool: index("ix_teacher_input_attachments_school_id").on(t.schoolId),
    ixInput: index("ix_teacher_input_attachments_input_id").on(t.inputId),
  }),
);
