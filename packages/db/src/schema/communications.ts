import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { communicationChannel } from "../_shared/enums.js";
import { advertisers } from "./advertisers.js";
import { contracts } from "./contracts.js";

/**
 * F10: 広告主とのコミュニケーション履歴（メール / 電話 / 商談など）。
 *
 * **cross-tenant / RLS 対象外**（middleware で `system_admin` 確認）。
 *
 * - 特定契約に紐付かない問い合わせ（新規 inbound 等）は `contract_id` を null にする。
 * - 親 `advertisers` の削除（実運用ではほぼ無いが）は cascade で履歴も消す。
 * - `body_md` は Markdown 想定（営業メモ・商談議事録）。
 * - `attachments_json` は Cloud Storage object 参照配列（PoC 中はバケット名込みの完全パス想定）。
 *
 * 関連: ADR-018 (CRM 独自設計), F10
 */
export const communications = pgTable(
  "communications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    advertiserId: uuid("advertiser_id")
      .notNull()
      .references(() => advertisers.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").references(() => contracts.id, { onDelete: "set null" }),
    channel: communicationChannel("channel").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    subject: varchar("subject", { length: 300 }).notNull(),
    bodyMd: text("body_md").notNull().default(""),
    attachmentsJson: jsonb("attachments_json").default(sql`'[]'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    ixAdvertiser: index("ix_communications_advertiser_id").on(t.advertiserId),
    ixOccurredAt: index("ix_communications_occurred_at").on(t.occurredAt),
    ixChannel: index("ix_communications_channel").on(t.channel),
  }),
);
