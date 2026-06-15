import { sql } from "drizzle-orm";
import { index, integer, pgTable, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { grades } from "./grades.js";
import { schools } from "./schools.js";

/**
 * クラス（HR）。校内で重複しない単一集合（年度では分けない）。
 *
 * `grade_id` は親学年への明示リンク（V1 Firestore のネスト
 * `schools/{s}/grades/{g}/classes/{c}` を #48-A でフラット化した際に失われたため復元）。
 * 広告階層マージ View `effective_ads_per_class`（#48-F）が class → grade → department を
 * 辿るのに必須。nullable（移行スクリプト #48-D が後追いで埋める／学年未割当も許容）。
 */
export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    gradeId: uuid("grade_id").references(() => grades.id, { onDelete: "set null" }),
    name: varchar("name", { length: 64 }).notNull(),
    grade: integer("grade").notNull(),
    ...auditColumns,
  },
  (t) => ({
    ixGrade: index("ix_classes_grade").on(t.gradeId),
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
  }),
);
