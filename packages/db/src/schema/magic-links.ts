import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schools } from "./schools.js";
import { users } from "./users.js";

/** F05: 保護者向けマジックリンク。token は hash で保存し、平文をログ・コードに残さない。 */
export const magicLinks = pgTable(
  "magic_links",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => ({
    ixToken: index("ix_magic_links_token_hash").on(t.tokenHash),
    ixSchool: index("ix_magic_links_school_id").on(t.schoolId),
  }),
);
