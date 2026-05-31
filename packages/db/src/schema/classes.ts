import { sql } from "drizzle-orm";
import { index, integer, pgTable, unique, uuid, varchar } from "drizzle-orm/pg-core";
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
  }),
);
