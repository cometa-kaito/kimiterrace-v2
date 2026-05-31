import { sql } from "drizzle-orm";
import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
    // FK は (content_id, school_id) の composite で張る (#204、下記 foreignKey 参照) —
    // cross-tenant write 整合を DB 強制 (別テナントの content を指す行を弾く)。
    contentId: uuid("content_id").notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    // PII マスキング後のテキストから生成した embedding（CLAUDE.md ルール4）
    embedding: vector("embedding"),
    diffSummary: text("diff_summary"),
    ...auditColumns,
  },
  (t) => ({
    // (content_id, version) は UNIQUE。同一 content への同時 publish/update で max+1 採番が
    // 衝突しても DB レベルで重複バージョンを弾く (#145 M-1、ルール2/3「DB レベル強制」)。
    // 通常は contents 行の FOR UPDATE ロック (contents-publish.ts) で直列化されエラーにならず、
    // ロックを経由しない経路が現れた場合の最終防壁として機能する。
    uxContentVer: uniqueIndex("ux_content_versions_content_version").on(t.contentId, t.version),
    // 子側 (publishes.(version_id, school_id)) から composite FK で参照される (#204)。
    uqIdSchool: unique("uq_content_versions_id_school").on(t.id, t.schoolId),
    // cross-tenant write 整合 (#204): content と school_id の一致を composite FK で強制。
    fkContent: foreignKey({
      columns: [t.contentId, t.schoolId],
      foreignColumns: [contents.id, contents.schoolId],
      name: "fk_content_versions_content",
    }).onDelete("cascade"),
  }),
);
