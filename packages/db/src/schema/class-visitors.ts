import { sql } from "drizzle-orm";
import { boolean, date, index, integer, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { classes } from "./classes.js";
import { schools } from "./schools.js";

/**
 * パターン2 サイネージ盤面の「来校者一覧」テーブル（クラス×日別の来校者レコード、2026-06-10 ユーザー確定）。
 *
 * ## スコープ — クラスごと×日別
 * 来校者は **クラス単位**（`class_id`）で**日付**（`visit_date`、JST 暦日）ごとに記録し、そのクラスの
 * パターン2 盤面に当日分を時刻順で出す。予定/連絡（daily_data のセクション）と異なり、複数フィールドを持つ
 * **構造化レコード**なので JSONB セクションではなく専用テーブルにする（時刻ソート・項目検証・監査の明確化）。
 * 階層継承（学校→学年→クラス）は持たない（来校者はそのクラス固有）。
 *
 * ## テナント分離（ルール2 / ADR-019）
 * `school_id` を持つテナント分離テーブル。RLS は migrations/0023_class_visitors_rls.sql で
 * tenant_isolation（school_id 一致）+ system_admin_full_access を付与する（tv_devices と同パターン）。
 * 編集（school_admin / teacher）・サイネージ読み取り（匿名・withTenantContext で school pin）とも
 * RLS が自校に限定し、手書き WHERE school_id には依存しない。
 *
 * ## 表示する個人情報について（設計軸の意識的な緩和）
 * `visitor_name`（来校者氏名）は **教室のサイネージに表示される**（ユーザー確定 2026-06-10）。サイネージは
 * 「クラス共通の公開情報のみ・個人 PII は出さない」という設計軸 [[project_school_dx_no_teacher_burden]] を
 * 来校者表示のために**意識的に緩和**したもの。来校者は外部の成人で、表示先は当該クラスの端末（classToken を
 * 持つ教室 TV）に限定され、RLS で自校スコープ・監査（ルール1）も残る。生徒実名表示（生徒呼び出し・後続 PR）と
 * 合わせて設計軸の反転は ADR で記録する。**Vertex AI には送らない**（LLM 経路外なのでルール4 のマスキング
 * 対象外）。氏名以外の項目（所属・用件・対応者）も施設/業務情報で、生徒個人の PII は入れない。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。created_by/updated_by → users(id) の FK は循環依存回避のため
 * migrations/0023 で後付けする（_shared/audit.ts と tv_devices/0016 と同じパターン）。編集は対象テーブル操作
 * として既存 `audit_log` に寄せる（呼び出し側 Action）。
 */
export const classVisitors = pgTable(
  "class_visitors",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // テナント分離キー。学校削除時は restrict（来校者行を残したまま親を消させない）。
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 対象クラス。クラス削除でレコードも削除（cascade。来校者はそのクラス固有で残す意味が無い）。
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    // 来校日（JST 暦日 YYYY-MM-DD）。daily_data.date と同じ date(mode:'string')。
    visitDate: date("visit_date", { mode: "string" }).notNull(),
    // 来校者氏名（必須）。★ サイネージ表示対象（上記「個人情報について」参照）。
    visitorName: varchar("visitor_name", { length: 100 }).notNull(),
    // 所属（会社/学校名、任意）。
    affiliation: varchar("affiliation", { length: 100 }),
    // 来校/予定時刻 "HH:MM"（任意）。一覧の並び順に使う。時刻として厳密検証はアプリ層（暴走入力は varchar 長で抑止）。
    scheduledTime: varchar("scheduled_time", { length: 5 }),
    // 用件/目的（任意）。例「面談」「業者打合せ」。生徒個人 PII を入れない（設置情報・業務ラベル）。
    purpose: varchar("purpose", { length: 200 }),
    // 対応者/訪問先（担当教員名・部署、任意）。
    host: varchar("host", { length: 100 }),
    // 備考（自由記述、任意）。
    note: text("note"),
    // 表示順（教員が来校者一覧を任意に並べ替える。盤面はこの昇順で描画する）。保存（全置換）時に編集 UI の
    // 行位置を 0,1,2... で採番する。既定 0（旧データ・未採番は時刻→氏名のタイブレークに委ねる）。migration 0034。
    sortOrder: integer("sort_order").notNull().default(0),
    // 重要マーク（★・PR-B §5.2）。盤面は既存の連絡★（isHighlight）と同一視覚（emphasis）で描く。
    // 既定 false（旧データ・未指定は通常表示）。migration 0037。
    isHighlight: boolean("is_highlight").notNull().default(false),
    ...auditColumns,
  },
  (t) => ({
    // クラス×日付での当日一覧取得（サイネージ・編集の主クエリ）。
    ixClassDate: index("ix_class_visitors_class_date").on(t.classId, t.visitDate),
    // school 別の運用一覧・ヘルス用。
    ixSchool: index("ix_class_visitors_school").on(t.schoolId),
  }),
);
