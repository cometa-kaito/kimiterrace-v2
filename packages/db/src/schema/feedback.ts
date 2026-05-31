import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schools } from "./schools.js";

/**
 * F12 (#48-M): キミテラス フィードバック。
 *
 * 教員・生徒・見学者など **誰でも (非認証で) 送れる** 受付。V1 Firestore `feedback/{id}`
 * (../キミテラス/functions/handlers/feedback.js) の移植。閲覧は **system_admin のみ**。
 *
 * ## cross-tenant / system_admin 専用 (ADR-019)
 * `school_id` は **テナント分離キーではなく任意の自己申告参照**である。投稿者は自分の学校を
 * 選ぶだけで、テナントコンテキスト (`app.current_school_id`) は確立されない (非認証投稿)。
 * したがって本テーブルは CRM (advertisers / contracts) と同じ **cross-tenant 系**で、RLS は
 * `system_admin_only` (FOR ALL) で守る。`school_id` 一致による可視化は **しない** —
 * 一致で可視にすると、攻撃者が自校 ID を `app.current_school_id` に張るだけで他人の
 * フィードバック (下記 PII を含む) を読めてしまう。SELECT は **絶対に system_admin に限定**する。
 *
 * 匿名 INSERT は通常 INSERT (RLS WITH CHECK) では通せない (テナント context も system_admin
 * role も無い) ため、専用の SECURITY DEFINER 関数 `submit_feedback(...)`
 * (migrations/0010_feedback_rls.sql) を「RLS をくぐる唯一の細い扉」として用意する。
 * `resolve_magic_link` (migrations/0008) と同じパターン。
 *
 * ## ★ PII 注意 (CLAUDE.md ルール4)
 * `student_episode` は自由記述で、**生徒氏名・保護者名等の PII を含みうる**。本テーブルは
 * **保存のみ**で、Vertex AI / LLM へは送信しない。将来この自由記述を LLM 連携 (要約・分類等)
 * に回す場合は、送信前に PII トークン化 (ルール4) が **必須**。生のまま LLM に投げてはならない。
 *
 * ## 監査 (CLAUDE.md ルール1)
 * `auditColumns` を付与。匿名投稿者には `created_by` / `updated_by` に載せる users.id が無い
 * ため、これらは NULL で記録する (投稿者特定はしない設計)。`submitted_at` で受付時刻を保持。
 *
 * 関連: ADR-019 (RLS 二層 / system_admin_only), ADR-018 (CRM cross-tenant), F12 (#48-M),
 *       Issue #124, V1 feedback.js。
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // 投稿者が選んだ学校名 (自己申告の自由テキスト)。表示の一次情報。
    schoolName: varchar("school_name", { length: 200 }),
    // 任意参照: 学校が特定できる場合のみ schools.id を載せる。テナント分離キーではない
    // (anonymous 投稿者は uuid を知らないのが通常で NULL になる)。親消滅で SET NULL。
    schoolId: uuid("school_id").references(() => schools.id, { onDelete: "set null" }),
    // 教室ラベル (例: "1-A")。自由テキスト。
    classroomLabel: varchar("classroom_label", { length: 100 }),
    // 生徒の反応・注目度 (1-5)。CHECK で範囲を DB レベル強制。
    studentReaction: integer("student_reaction").notNull(),
    // 先生の業務負担・利便性 (1-5)。
    teacherUtility: integer("teacher_utility").notNull(),
    // ★ PII を含みうる自由記述 (生徒名等)。保存のみ・LLM 非送信。ルール4 参照。
    studentEpisode: text("student_episode"),
    // 改善要望・気付き (自由記述)。
    improvement: text("improvement"),
    // 受付時刻 (V1 の送信日時相当)。created_at と同義だが V1 互換のため明示列を持つ。
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    ...auditColumns,
  },
  (t) => ({
    ixSubmittedAt: index("ix_feedback_submitted_at").on(t.submittedAt),
    ixSchoolId: index("ix_feedback_school_id").on(t.schoolId),
    // 1-5 範囲を DB レベルで強制 (アプリ層検証の多層防御)。
    ckStudentReaction: check(
      "ck_feedback_student_reaction",
      sql`${t.studentReaction} BETWEEN 1 AND 5`,
    ),
    ckTeacherUtility: check(
      "ck_feedback_teacher_utility",
      sql`${t.teacherUtility} BETWEEN 1 AND 5`,
    ),
  }),
);
