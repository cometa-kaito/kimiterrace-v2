import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { teacherInputStatus, teacherInputType } from "../_shared/enums.js";
import { schools } from "./schools.js";
import { users } from "./users.js";

/**
 * F02: 教員の音声 / チャット入力。
 *
 * 教員が「明日 10 時から体育館で説明会」と音声 or チャットで入力した生テキストを保持し、
 * F03 (AI 構造化) へ渡す前段の作業領域。ライフサイクルは
 * draft → (transcribing →) ready → submitted。
 *
 * **テナント分離 (RLS 対象)**: `school_id` を持つ。0009_f02_schema_rls.sql で
 * tenant_isolation + system_admin_full_access policy を貼る (ADR-019 / CLAUDE.md ルール2)。
 *
 * **PII (CLAUDE.md ルール4)**: `transcript` は生徒氏名等の PII を含みうる。本スライスでは
 * Vertex AI 送信が無いため、保存時の RLS + 監査ログで担保する。F03 連携 (submit) 時に
 * Vertex AI へ渡す段でマスキングを行う — それは本スライスのスコープ外 (下記 TODO)。
 *
 * TODO(F03 連携): submit 後に PII マスキング → Vertex AI 構造化ジョブを起動する経路は別 PR。
 * TODO(音声): 実際の録音 UI・Cloud Speech-to-Text / Vertex AI 文字起こしジョブは別 PR。
 *   本テーブルは `audio_path` (Cloud Storage 参照) と `status='transcribing'` の置き場のみ用意する。
 *
 * 関連: F02 (docs/requirements/functional/F02-teacher-voice-chat-input.md),
 *       ADR-005 (Vertex AI), ADR-006 (Vercel AI SDK), ADR-019 (RLS)
 */
export const teacherInputs = pgTable(
  "teacher_inputs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 入力した教員。users 物理削除時は履歴を残すため SET NULL。
    teacherId: uuid("teacher_id").references(() => users.id, { onDelete: "set null" }),
    inputType: teacherInputType("input_type").notNull(),
    status: teacherInputStatus("status").notNull().default("draft"),
    // 音声入力時の Cloud Storage object 参照 (FR-05 とは別。録音音声そのもの)。
    // 要件 §音声データは保存しない方針のため通常はテキスト化後 null だが、
    // 文字起こしジョブ処理中の一時参照として保持しうる (TODO: 破棄経路は別 PR)。
    audioPath: text("audio_path"),
    // 文字起こし / チャット本文。draft 段階では null もありうる。
    transcript: text("transcript"),
    // FR-04: 教員が transcript を手編集したか。
    transcriptEdited: boolean("transcript_edited").notNull().default(false),
    // FR-07: F03 へ送信した時刻。未送信は null。
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
    ...auditColumns,
  },
  (t) => ({
    ixSchool: index("ix_teacher_inputs_school_id").on(t.schoolId),
    ixTeacher: index("ix_teacher_inputs_teacher_id").on(t.teacherId),
    ixStatus: index("ix_teacher_inputs_status").on(t.status),
  }),
);
