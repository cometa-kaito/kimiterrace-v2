import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { communicationChannel } from "../_shared/enums.js";
import { advertisers } from "./advertisers.js";

/**
 * F10: 広告主とのコミュニケーション履歴（営業ログ）。
 *
 * 横断テーブル（`school_id` を持たない）。CRM 系は RLS 対象外、middleware の
 * `system_admin` チェックでアクセス制御する（ADR-018, ADR-019）。
 *
 * - `channel` は enum (`communication_channel`: email / phone / meeting / other)。
 * - `handled_by` は対応した社内担当者（users.id）。退職等で users 削除時は set null。
 * - `occurred_at` は実際の通話/面談/メール時刻（記録時刻ではない）。
 *
 * 関連: F10 (docs/requirements/functional/F10-crm.md), ADR-018, ADR-019
 */
export const communications = pgTable(
  "communications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    advertiserId: uuid("advertiser_id")
      .notNull()
      .references(() => advertisers.id, { onDelete: "cascade" }),
    channel: communicationChannel("channel").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
    // 対応した社内担当者（users.id への論理参照）。
    // 循環依存を避けるため FK 制約は migration 側で付与する。
    handledBy: uuid("handled_by"),
    summary: text("summary").notNull(),
    ...auditColumns,
  },
  (t) => ({
    ixAdvertiser: index("ix_communications_advertiser_id").on(t.advertiserId),
    ixOccurred: index("ix_communications_occurred_at").on(t.occurredAt),
  }),
);
