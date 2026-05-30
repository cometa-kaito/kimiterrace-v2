import { sql } from "drizzle-orm";
import { check, date, index, jsonb, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { hierarchyScope } from "../_shared/enums.js";
import { classes } from "./classes.js";
import { departments } from "./departments.js";
import { grades } from "./grades.js";
import { schools } from "./schools.js";

/**
 * 日次データ。V1 Firestore `master_daily_data/{date}` および
 * `.../classes/{c}/daily_data/{date}` の移植。
 *
 * - `scope` + 各 *_id で学校/学年/クラス/学科のどの階層の 1 日分かを判別
 * - 階層マージ（親階層を子に伝搬）は #48-F の Materialized View で行う
 * - schedules / notices / assignments / quiet_hours は V1 の document 配列をそのまま
 *   JSONB で保持。正規化（個別テーブル化）が必要になれば #48-H / #48-I で検討。
 *   各要素の形は `docs/architecture/v1-v2-mapping.md` を参照。
 */
export const dailyData = pgTable(
  "daily_data",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    scope: hierarchyScope("scope").notNull(),
    gradeId: uuid("grade_id").references(() => grades.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
    classId: uuid("class_id").references(() => classes.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    schedules: jsonb("schedules").notNull().default(sql`'[]'::jsonb`),
    notices: jsonb("notices").notNull().default(sql`'[]'::jsonb`),
    assignments: jsonb("assignments").notNull().default(sql`'[]'::jsonb`),
    quietHours: jsonb("quiet_hours").notNull().default(sql`'[]'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    uxTargetDate: unique("ux_daily_data_target_date")
      .on(t.schoolId, t.scope, t.gradeId, t.departmentId, t.classId, t.date)
      .nullsNotDistinct(),
    ixSchoolDate: index("ix_daily_data_school_date").on(t.schoolId, t.date),
    ckScope: check(
      "ck_daily_data_scope",
      sql`(
        (${t.scope} = 'school' AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL AND ${t.departmentId} IS NULL)
        OR (${t.scope} = 'grade' AND ${t.gradeId} IS NOT NULL AND ${t.classId} IS NULL)
        OR (${t.scope} = 'department' AND ${t.departmentId} IS NOT NULL AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL)
        OR (${t.scope} = 'class' AND ${t.classId} IS NOT NULL)
      )`,
    ),
  }),
);
