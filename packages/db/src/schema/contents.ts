import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { contentStatus, publishScope } from "../_shared/enums.js";
import { schools } from "./schools.js";

/** F01-F04: コンテンツ本体。embedding は content_versions 側に持たせる。 */
export const contents = pgTable(
  "contents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 300 }).notNull(),
    body: text("body").notNull().default(""),
    publishScope: publishScope("publish_scope").notNull(),
    status: contentStatus("status").notNull().default("draft"),
    // 配信対象（class_id 配列 / 部活 など）— jsonb で柔軟に
    targets: jsonb("targets").notNull().default(sql`'[]'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    ixSchool: index("ix_contents_school_id").on(t.schoolId),
    ixStatus: index("ix_contents_status").on(t.status),
  }),
);
