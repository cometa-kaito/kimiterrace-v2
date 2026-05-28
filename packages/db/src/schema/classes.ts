import { sql } from "drizzle-orm";
import { index, integer, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schools } from "./schools.js";

/** クラス（HR）。年度ごとに新規発行される想定。 */
export const classes = pgTable(
  "classes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    academicYear: integer("academic_year").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    grade: integer("grade").notNull(),
    ...auditColumns,
  },
  (t) => ({
    ixSchoolYear: index("ix_classes_school_year").on(t.schoolId, t.academicYear),
  }),
);
