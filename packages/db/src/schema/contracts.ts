import { sql } from "drizzle-orm";
import { date, index, numeric, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { contractStatus } from "../_shared/enums.js";
import { advertisers } from "./advertisers.js";
import { schools } from "./schools.js";

/**
 * F10: 広告主契約。
 *
 * 横断テーブル（`school_id` は配信対象の学校だが、CRM 観点では RLS 対象外。
 * テナント分離は middleware の `system_admin` チェックで制御する。ADR-018, ADR-019）。
 *
 * - `monthly_fee` は税抜月額（円）。numeric(12,2) で 0.01 円精度まで保持。
 * - `status` は enum (`contract_status`: draft / active / paused / terminated)。
 * - 期間は `start_date` / `end_date` の half-open [start, end)。`end_date` null は無期限。
 *
 * 関連: F10 (docs/requirements/functional/F10-crm.md), ADR-018, ADR-019
 */
export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    advertiserId: uuid("advertiser_id")
      .notNull()
      .references(() => advertisers.id, { onDelete: "restrict" }),
    // 配信対象学校（CRM 系は RLS 対象外。テナント分離は middleware で）
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    startDate: date("start_date").notNull(),
    // null = 無期限
    endDate: date("end_date"),
    // 税抜月額（円）。例: 50000.00
    monthlyFee: numeric("monthly_fee", { precision: 12, scale: 2 }).notNull(),
    status: contractStatus("status").notNull().default("draft"),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => ({
    ixAdvertiser: index("ix_contracts_advertiser_id").on(t.advertiserId),
    ixSchool: index("ix_contracts_school_id").on(t.schoolId),
    ixStatus: index("ix_contracts_status").on(t.status),
  }),
);
