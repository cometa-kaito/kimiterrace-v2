import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";

/**
 * cross-tenant allowlist（システム管理者）。
 *
 * 横断テーブル（`school_id` を持たない）。RLS は対象外で、`system_admin` 自体の判定は
 * middleware が起動時にこのテーブルを参照して行う（ADR-018, ADR-019）。
 *
 * - `user_id` は `users.id` への論理参照。`users` 側との循環依存を避けるため FK 制約は
 *   migration 側で `ALTER TABLE ... ADD CONSTRAINT` する（Part C2 で実装）。
 * - 同一ユーザーの重複付与を防ぐため `user_id` に UNIQUE 制約。
 * - `reason` は付与理由（社内承認の根拠）。監査要件で必須。
 * - 失効は `revoked_at` を立てる append-only 運用（履歴を消さない）。
 *
 * 関連: ADR-018, ADR-019, F11 (docs/requirements/functional/F11-role-management.md)
 */
export const systemAdmins = pgTable(
  "system_admins",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // users.id への論理参照（FK 制約は migration 側）
    userId: uuid("user_id").notNull(),
    reason: text("reason").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().default(sql`now()`),
    // null = 有効。失効時刻を立てて append-only 運用
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => ({
    uxUser: uniqueIndex("ux_system_admins_user_id").on(t.userId),
  }),
);
