import { sql } from "drizzle-orm";
import { pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";

/**
 * F10: 広告主マスタ。
 *
 * 横断テーブル（`school_id` を持たない）。CRM 系は RLS 対象外で、middleware の
 * `system_admin` チェックでアクセス制御する（ADR-018, ADR-019）。
 *
 * - PII: `contact_*` / `address` は広告主担当者の連絡先（B2B）。生徒 PII は含まない。
 * - 契約 (`contracts`) / コミュニケーション履歴 (`communications`) / 月次レポート
 *   (`monthly_reports`) はこのテーブルを起点に辿る。
 *
 * 関連: F10 (docs/requirements/functional/F10-crm.md), ADR-018, ADR-019
 */
export const advertisers = pgTable("advertisers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // 法人名（必須）。例: "株式会社サンプル"
  companyName: varchar("company_name", { length: 200 }).notNull(),
  // 主担当者氏名
  contactName: varchar("contact_name", { length: 100 }),
  contactEmail: varchar("contact_email", { length: 320 }),
  contactPhone: varchar("contact_phone", { length: 32 }),
  address: text("address"),
  // 営業メモ・備考
  notes: text("notes"),
  ...auditColumns,
});
