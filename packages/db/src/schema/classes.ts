import { sql } from "drizzle-orm";
import { index, integer, pgTable, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { departments } from "./departments.js";
import { grades } from "./grades.js";
import { schools } from "./schools.js";

/**
 * クラス（HR）。校内で重複しない単一集合（年度では分けない）。
 *
 * `grade_id` は親学年への明示リンク（V1 Firestore のネスト
 * `schools/{s}/grades/{g}/classes/{c}` を #48-A でフラット化した際に失われたため復元）。
 * 広告階層マージ View `effective_ads_per_class`（#48-F）が class → grade → department を
 * 辿るのに必須。nullable（移行スクリプト #48-D が後追いで埋める／学年未割当も許容）。
 *
 * ## 「その他」（非教室の設置場所）= `grade_id IS NULL` のクラス
 * 玄関・廊下・職員室前などクラス内以外のサイネージ設置場所も「クラス」として表現する（独自の
 * `daily_data` / magic link / TV 紐付け / パターンを再利用するため）。学年に属さない設置場所は
 * `grade_id` を NULL にし、所属学科は **`department_id`（本テーブル直持ち）** で表す（通常クラスは
 * 学科を `grade_id → grades.department_id` 経由で持つが、学年なしクラスはその経路を辿れないため）。
 * `grade`（学年番号）も「その他」では無意味なので NULL 可にした。サイネージ表示の階層フォールバックは
 * class → (grade) → department → school で、学年なしクラスは department を `classes.department_id`
 * から解決する（`effective-daily-data.ts` の `resolveClassHierarchy`）。
 */
export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    gradeId: uuid("grade_id").references(() => grades.id, { onDelete: "set null" }),
    // 「その他」(学年なしクラス) の所属学科を直接持つ。学校直下の「その他」は NULL。通常クラスは
    // 学科を grade 経由で持つため通常 NULL（grade_id が NULL のときだけ意味を持つ）。
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    name: varchar("name", { length: 64 }).notNull(),
    // 学年番号（1年=1 等）。「その他」(grade_id NULL) では無意味なので nullable。
    grade: integer("grade"),
    ...auditColumns,
  },
  (t) => ({
    ixGrade: index("ix_classes_grade").on(t.gradeId),
    ixDepartment: index("ix_classes_department").on(t.departmentId),
    // 子側 (ai_chat_sessions.(class_id, school_id)) から composite FK で参照される (#73)。
    uqIdSchool: unique("uq_classes_id_school").on(t.id, t.schoolId),
    // 校内のクラスは「学年(grade_id) × クラス名」で一意（年度撤去後の単一集合・同名クラスは 1 行のみ）。
    // grade_id IS NULL（学年未割当）は掲示階層外なので制約しない（部分 index の WHERE で除外。NULL を
    // 含めると Postgres は NULL を distinct 扱いするので無意味な行も通してしまう）。
    // school_id を鍵に含めるのは classes がマルチテナント（全校の行を 1 テーブルに保持）で、一意性は
    // 校内に閉じるため（RLS は SELECT/書込みを自校に限定するが index は全テナント横断ゆえ school_id が必須）。
    uxSchoolGradeName: uniqueIndex("ux_classes_school_grade_name")
      .on(t.schoolId, t.gradeId, t.name)
      .where(sql`${t.gradeId} IS NOT NULL`),
    // 「その他」(grade_id NULL) のクラス名は「学科(department_id) × 名前」で一意（学科配下の同名設置場所を
    // 1 行に。学校直下＝department_id NULL は Postgres が NULL を distinct 扱いするため DB では強制されず、
    // create action 側の自校重複チェックで補完する）。
    uxSchoolDeptOtherName: uniqueIndex("ux_classes_school_dept_other_name")
      .on(t.schoolId, t.departmentId, t.name)
      .where(sql`${t.gradeId} IS NULL`),
  }),
);
