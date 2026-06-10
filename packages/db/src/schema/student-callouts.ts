import { sql } from "drizzle-orm";
import { date, index, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { classes } from "./classes.js";
import { schools } from "./schools.js";

/**
 * パターン2 サイネージ盤面の「生徒呼び出し」テーブル（クラス×日別の呼び出しレコード、2026-06-10 ユーザー確定）。
 *
 * ## スコープ — クラスごと×日別（class_visitors と同型）
 * 呼び出しは **クラス単位**（`class_id`）で**日付**（`callout_date`、JST 暦日）ごとに記録し、そのクラスの
 * パターン2 盤面に当日分を時刻順で出す。階層継承は持たない（呼び出しはそのクラス固有）。職員が明示的に入力する
 * （AI 自動生成・自動取込みではない）。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。RLS は migrations/0024_student_callouts_rls.sql で
 * tenant_isolation（school_id 一致）+ system_admin_full_access を付与する（class_visitors / tv_devices と同型）。
 *
 * ## ★ 生徒実名の表示について（ADR-034）
 * `student_name` は **生徒のフルネーム**で、**教室のサイネージに表示**される（ユーザー確定 2026-06-10）。これは
 * 設計軸 [[project_school_dx_no_teacher_burden]]（サイネージは個別 PII を出さない）と ADR-030（掲示物に生徒氏名を
 * 載せない）を、**呼び出し運用のために意識的に緩和**したもの（[ADR-034](../../docs/adr/034-personal-names-on-classroom-signage.md)）。
 * 境界: 表示先は classToken を持つ当該クラス端末に限定・RLS 自校スコープ・**Vertex には送らない**（ルール4 のマスキング
 * 対象外＝LLM/embedding 経路に入れない）・監査あり・クラス×日別で職員 curate。出席番号ではなく実名なのは呼び出しの
 * 取り違え防止のため（ADR-034 §決定）。生徒以外の個人 PII（保護者名等）は入れない。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。created_by/updated_by → users(id) の FK は循環依存回避のため
 * migrations/0024 で後付けする（class_visitors / tv_devices と同じパターン）。監査 diff には氏名を焼かず件数のみ
 * （ADR-034 §決定4）。
 */
export const studentCallouts = pgTable(
  "student_callouts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // テナント分離キー。学校削除時は restrict。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 対象クラス。クラス削除でレコードも削除（cascade）。
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    // 呼び出し日（JST 暦日 YYYY-MM-DD）。
    calloutDate: date("callout_date", { mode: "string" }).notNull(),
    // 呼び出す生徒の氏名（必須・フルネーム）。★ サイネージ表示対象（上記「生徒実名の表示について」/ ADR-034）。
    studentName: varchar("student_name", { length: 100 }).notNull(),
    // 呼び出し先（場所、任意）。例「職員室」「保健室」。
    location: varchar("location", { length: 100 }),
    // 用件/理由（任意）。例「忘れ物」「面談」「電話」。生徒個人の機微情報は入れない。
    reason: varchar("reason", { length: 200 }),
    // 呼び出し/予定時刻 "HH:MM"（任意）。一覧の並び順に使う。形式検証はアプリ層。
    scheduledTime: varchar("scheduled_time", { length: 5 }),
    ...auditColumns,
  },
  (t) => ({
    // クラス×日付での当日一覧取得（サイネージ・編集の主クエリ）。
    ixClassDate: index("ix_student_callouts_class_date").on(t.classId, t.calloutDate),
    // school 別の運用一覧用。
    ixSchool: index("ix_student_callouts_school").on(t.schoolId),
  }),
);
