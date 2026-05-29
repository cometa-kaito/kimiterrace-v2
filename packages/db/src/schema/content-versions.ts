import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { vector } from "../_shared/pgvector.js";
import { contents } from "./contents.js";
import { schools } from "./schools.js";

/** F04.2: コンテンツ全バージョン保管（rollback / 差分監査用）。 */
export const contentVersions = pgTable(
  "content_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    // PII マスキング後のテキストから生成した embedding（CLAUDE.md ルール4）
    embedding: vector("embedding"),
    diffSummary: text("diff_summary"),
    ...auditColumns,
  },
  (t) => ({
    ixContentVer: index("ix_content_versions_content_version").on(t.contentId, t.version),
  }),
);
