import { sql } from "drizzle-orm";
import { pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { classes } from "./classes.js";
import { schools } from "./schools.js";
import { users } from "./users.js";

/** ユーザー × クラスの所属（生徒・担任・副担任）。 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'student' | 'homeroom_teacher' | 'sub_teacher' （文字列で柔軟運用、ロール拡張時に enum 化）
    membershipRole: varchar("membership_role", { length: 32 }).notNull(),
    ...auditColumns,
  },
  (t) => ({
    uxClassUser: uniqueIndex("ux_memberships_class_user").on(t.classId, t.userId),
  }),
);
