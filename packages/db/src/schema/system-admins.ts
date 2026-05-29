import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";

/**
 * F11: システム管理者 allowlist。
 *
 * **cross-tenant / RLS 対象外**。ADR-019 (RLS 二層) における **system_admin の唯一の真実の源**。
 *
 * - `users` テーブルとは別管理（`users` は school_id でテナントに紐付くが、system_admin は
 *   テナント外）。これにより「system_admin 判定 = `system_admins.is_active = true` AND
 *   `identity_uid` 一致」とシンプルに表現できる。
 * - `is_active = false` で即座に権限剥奪（物理削除しない＝就任履歴を残す）。
 * - middleware で都度参照される高頻度クエリのため、`identity_uid` / `email` / `is_active` に
 *   index を貼る。
 *
 * 関連: ADR-019 (RLS 二層), F11 (docs/requirements/functional/F11-role-management.md)
 */
export const systemAdmins = pgTable(
  "system_admins",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    identityUid: varchar("identity_uid", { length: 128 }).notNull(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => ({
    uxIdentityUid: uniqueIndex("ux_system_admins_identity_uid").on(t.identityUid),
    uxEmail: uniqueIndex("ux_system_admins_email").on(t.email),
    ixActive: index("ix_system_admins_is_active").on(t.isActive),
  }),
);
