import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { contentVersions } from "./content-versions.js";
import { contents } from "./contents.js";
import { schools } from "./schools.js";

/** コンテンツ公開イベント（どのバージョンを公開したか）。 */
export const publishes = pgTable(
  "publishes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => contentVersions.id, { onDelete: "restrict" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().default(sql`now()`),
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => ({ ixContent: index("ix_publishes_content").on(t.contentId) }),
);
