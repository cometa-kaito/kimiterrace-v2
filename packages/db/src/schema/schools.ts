import { sql } from "drizzle-orm";
import { boolean, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schoolHierarchyMode } from "../_shared/enums.js";

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
  // 階層モード（V1 schools.hierarchyMode 相当）。class=学年>クラス / department=学年>学科>クラス。
  // 既存校は普通科前提で class をデフォルトとする（#48-L / #123）。
  hierarchyMode: schoolHierarchyMode("hierarchy_mode").notNull().default("class"),
  // 教員「学校共通パスワード」ログインの有効/無効（ADR-032）。system_admin が共通パスワードを設定すると
  // true になり、ログイン画面の学校選択にこの学校が現れる。★ パスワード（およびそのハッシュ）は本テーブルに
  // 保存しない — Identity Platform 側の per-school 共通教員アカウントに Google がハッシュ保管する（ルール5:
  // 秘密を自前 DB に置かない）。本フラグは「この学校が共通パスワードログインを提供しているか」のみを表す。
  teacherLoginEnabled: boolean("teacher_login_enabled").notNull().default(false),
  notes: text("notes"),
  ...auditColumns,
});
