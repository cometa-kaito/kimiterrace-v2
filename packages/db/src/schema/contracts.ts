import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { contractStatus } from "../_shared/enums.js";
import { advertisers } from "./advertisers.js";

/**
 * F10: 広告主との契約。
 *
 * **cross-tenant マスタ（テナント分離なし）だが RLS 有効**。`system_admin_full_access` ポリシー
 * （migration 0002）で DB 層も system_admin のみ全アクセス可。middleware（第一層）+ RLS（DB 層）の二層。
 *
 * - `target_schools` は配信対象校 (`schools.id`) の jsonb 配列。学校ごとの紐付けを正規化テーブル
 *   ではなく jsonb で持つのは、契約改定時の上書きを 1 行で扱いたい運用要件のため。
 * - `monthly_fee_jpy` は税抜 / 税込みの区別は仕様確定後に列追加。現状は税抜想定。
 * - `advertiser_id` の親消滅は `restrict`（契約履歴は残す）。
 *
 * 関連: ADR-018 (CRM 独自設計), F10 (docs/requirements/functional/F10-crm.md)
 */
export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    advertiserId: uuid("advertiser_id")
      .notNull()
      .references(() => advertisers.id, { onDelete: "restrict" }),
    status: contractStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    monthlyFeeJpy: integer("monthly_fee_jpy").notNull(),
    // 配信対象校 (school_id の配列)。空配列は「全校配信」ではなく「未指定」を意味する。
    targetSchools: jsonb("target_schools").notNull().default(sql`'[]'::jsonb`),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => ({
    ixAdvertiser: index("ix_contracts_advertiser_id").on(t.advertiserId),
    ixStatus: index("ix_contracts_status").on(t.status),
    ixStartedAt: index("ix_contracts_started_at").on(t.startedAt),
  }),
);
