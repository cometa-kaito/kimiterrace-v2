import { sql } from "drizzle-orm";
import { boolean, index, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { userRole } from "../_shared/enums.js";
import { schools } from "./schools.js";

/**
 * テナント内ユーザー（教員・生徒・保護者・学校管理者）。
 * - PII を含むため、選択時は drizzle-zod の output スキーマでマスキング想定。
 * - 認証は Identity Platform。`identity_uid` で照合する。
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    identityUid: varchar("identity_uid", { length: 128 }).notNull(),
    role: userRole("role").notNull(),
    // PII（drizzle-zod 出力ではマスキング対象）
    displayName: varchar("display_name", { length: 100 }).notNull(),
    email: varchar("email", { length: 320 }),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => ({
    uxIdentity: uniqueIndex("ux_users_identity_uid").on(t.identityUid),
    ixSchool: index("ix_users_school_id").on(t.schoolId),
  }),
);
