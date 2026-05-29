import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { eventType } from "../_shared/enums.js";
import { contents } from "./contents.js";
import { schools } from "./schools.js";
import { users } from "./users.js";

/** F07: 行動ログ（view/tap/dwell/ask）。 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "set null" }),
    type: eventType("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({ ixSchoolTime: index("ix_events_school_time").on(t.schoolId, t.occurredAt) }),
);
