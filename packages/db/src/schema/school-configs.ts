import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { configKind, hierarchyScope } from "../_shared/enums.js";
import { classes } from "./classes.js";
import { departments } from "./departments.js";
import { grades } from "./grades.js";
import { schools } from "./schools.js";

/**
 * 学校設定。V1 Firestore `schools/{s}/config/{kind}`（および学年/学科/クラスの config）の移植。
 *
 * - `kind`: display_settings / quiet_hours / schedule_templates の 3 種
 * - `scope` + 各 *_id で「どの階層の設定か」を判別（広告 ads は別テーブルに正規化済）
 * - `value`: 設定本体（quiet_hours の時間帯配列、schedule_templates の曜日別テンプレ等）を JSONB 保持
 *
 * 1 つの (school, scope ターゲット, kind) につき設定は 1 行（NULLS NOT DISTINCT で
 * scope='school' のように *_id が全 NULL のケースも一意制約が効くようにする）。
 */
export const schoolConfigs = pgTable(
  "school_configs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    scope: hierarchyScope("scope").notNull(),
    gradeId: uuid("grade_id").references(() => grades.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
    classId: uuid("class_id").references(() => classes.id, { onDelete: "cascade" }),
    kind: configKind("kind").notNull(),
    value: jsonb("value").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    uxTarget: unique("ux_school_configs_target")
      .on(t.schoolId, t.scope, t.gradeId, t.departmentId, t.classId, t.kind)
      .nullsNotDistinct(),
    ckScope: check(
      "ck_school_configs_scope",
      sql`(
        (${t.scope} = 'school' AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL AND ${t.departmentId} IS NULL)
        OR (${t.scope} = 'grade' AND ${t.gradeId} IS NOT NULL AND ${t.classId} IS NULL)
        OR (${t.scope} = 'department' AND ${t.departmentId} IS NOT NULL AND ${t.gradeId} IS NULL AND ${t.classId} IS NULL)
        OR (${t.scope} = 'class' AND ${t.classId} IS NOT NULL)
      )`,
    ),
  }),
);
