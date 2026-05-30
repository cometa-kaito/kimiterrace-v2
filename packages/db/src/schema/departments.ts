import { sql } from "drizzle-orm";
import { index, integer, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schools } from "./schools.js";

/**
 * 学科マスタ。V1 Firestore `schools/{s}/departments/{d}` の移植。
 *
 * `hierarchyMode='department'` の学校でのみ使用される（普通科高校では空）。
 * 学科モードでは departments → grades → classes の 4 階層になる。
 */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 64 }).notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => ({
    uxSchoolName: uniqueIndex("ux_departments_school_name").on(t.schoolId, t.name),
    ixSchoolOrder: index("ix_departments_school_order").on(t.schoolId, t.displayOrder),
  }),
);
