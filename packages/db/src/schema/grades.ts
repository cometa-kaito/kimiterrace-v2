import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { departments } from "./departments.js";
import { schools } from "./schools.js";

/**
 * 学年マスタ。V1 Firestore `schools/{s}/grades/{g}` の移植。
 *
 * - クラスモード: grades 直下に classes がぶら下がる（`department_id` は NULL）
 * - 学科モード: departments → grades → classes（`department_id` で親学科を指す）
 *
 * `has_classes=false` の場合は学年自体が 1 表示単位（クラスを持たない）。
 * `department_id` は学科モード校でのみ非 NULL。広告階層マージ View `effective_ads_per_class`
 * （#48-F）が grade → department の伝搬を辿るのに使う。
 */
export const grades = pgTable(
  "grades",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    name: varchar("name", { length: 64 }).notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    hasClasses: boolean("has_classes").notNull().default(true),
    ...auditColumns,
  },
  (t) => ({
    uxSchoolName: uniqueIndex("ux_grades_school_name").on(t.schoolId, t.name),
    ixSchoolOrder: index("ix_grades_school_order").on(t.schoolId, t.displayOrder),
    ixDepartment: index("ix_grades_department").on(t.departmentId),
  }),
);
