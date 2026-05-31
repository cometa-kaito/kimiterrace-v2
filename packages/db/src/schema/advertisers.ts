import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";

/**
 * F10: 広告主マスタ（CRM）。
 *
 * **cross-tenant マスタ（テナント分離はしない）。ただし RLS は有効**で、`system_admin_full_access`
 * ポリシー（migration 0002）が **system_admin のみ全アクセス可**＝DB 層でも非 system_admin を遮断する。
 * アクセス制御は middleware 層（第一層）+ RLS ポリシー（DB 層）の二層（ADR-019 RLS 二層モデル）。
 *
 * - 営業上の連絡先・業種・備考を保持。請求や契約条件は contracts に分離する。
 * - `is_active` で論理削除（過去契約のトレースを残すため物理 DELETE は推奨しない）。
 *
 * 関連: ADR-018 (CRM 独自設計), ADR-019 (RLS 二層), F10 (docs/requirements/functional/F10-crm.md)
 */
export const advertisers = pgTable(
  "advertisers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyName: varchar("company_name", { length: 200 }).notNull(),
    industry: varchar("industry", { length: 100 }),
    contactEmail: varchar("contact_email", { length: 320 }),
    contactPhone: varchar("contact_phone", { length: 50 }),
    address: text("address"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => ({
    ixCompanyName: index("ix_advertisers_company_name").on(t.companyName),
    ixActive: index("ix_advertisers_is_active").on(t.isActive),
  }),
);
