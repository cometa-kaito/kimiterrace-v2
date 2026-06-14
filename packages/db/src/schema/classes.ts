import { sql } from "drizzle-orm";
import { index, integer, pgTable, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { grades } from "./grades.js";
import { schools } from "./schools.js";

/**
 * クラス（HR）。年度ごとに新規発行される想定。
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
    academicYear: integer("academic_year").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    grade: integer("grade").notNull(),
    ...auditColumns,
  },
  (t) => ({
    ixSchoolYear: index("ix_classes_school_year").on(t.schoolId, t.academicYear),
    ixGrade: index("ix_classes_grade").on(t.gradeId),
    // 子側 (ai_chat_sessions.(class_id, school_id)) から composite FK で参照される (#73)。
    uqIdSchool: unique("uq_classes_id_school").on(t.id, t.schoolId),
    // 「新年度へ複製」(duplicateClassesToNextYearAction) の並行実行 / 別タブ再実行による翌年度クラスの
    // 重複生成を **DB レベルで封じる**部分 UNIQUE index。同一校・同一年度・同一学年(grade_id)・同名クラスは
    // 1 行のみに直列化する。grade_id IS NULL（学年未割当）は複製対象外かつ掲示階層外なので制約しない
    // （部分 index の WHERE で除外。NULL を含めると Postgres は NULL を distinct 扱いするので無意味な行も
    // 通してしまう）。app 層 (planNextYearDuplication + 既存 target 除外) は graceful skip を狙うが、
    // READ COMMITTED の phantom race（両 tx が事前 SELECT で 0 行を観測→両方 INSERT）は app 層では塞げない。
    // 本 index を直列化の真の砦にし、競合 INSERT は 23505 → finish の conflict 写像で graceful に返す。
    uxSchoolYearGradeName: uniqueIndex("ux_classes_school_year_grade_name")
      .on(t.schoolId, t.academicYear, t.gradeId, t.name)
      .where(sql`${t.gradeId} IS NOT NULL`),
  }),
);
