import { sql } from "drizzle-orm";
import { pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";

/**
 * 学校（テナント）マスタ。RLS 上の `school_id` 値の発行元。
 * schools 自体には school_id カラムは無いが、RLS で system_admin のみ書き込み可とする。
 */
export const schools = pgTable("schools", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 200 }).notNull(),
  prefecture: varchar("prefecture", { length: 32 }).notNull(),
  // 学校コード（文科省標準 / 任意）
  code: varchar("code", { length: 32 }),
  notes: text("notes"),
  ...auditColumns,
});
