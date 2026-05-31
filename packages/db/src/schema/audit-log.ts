import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { auditOp } from "../_shared/enums.js";

/**
 * NFR04: 監査ログ（append-only、hash chain）。
 *
 * **cross-tenant マスタ（テナント分離なし）だが RLS 有効（FORCE RLS）**。`audit_log_tenant_read`
 * （SELECT: 自テナント or system_admin）+ `audit_log_insert`（INSERT のみ）ポリシー（migration 0002）で
 * 保護し、UPDATE/DELETE は append-only トリガ + REVOKE で封じる（下記）。`school_id` は nullable
 * （system_admin 操作のようにテナント横断のものは null）。
 *
 * ## 不変条件（Part C2 で SQL レベルに強制する）
 * - **append-only**: UPDATE / DELETE 禁止。Part C2 で RLS policy + REVOKE で物理的に封じる。
 * - **hash chain**: 各行は直前行の `row_hash` を `prev_hash` として保持し、
 *   `row_hash = SHA-256(prev_hash || actor_user_id || table_name || record_id || operation || occurred_at || diff)`
 *   で連鎖させる。任意の行の改竄を後段の `row_hash` 計算が検出する。
 *
 * ## 形式
 * - `actor_user_id`: 操作者 `users.id`。バッチ・トリガからの自動挿入は null。
 * - `actor_identity_uid`: Identity Platform UID のキャッシュ（`users` 削除後も追跡可能に）。
 * - `record_id`: 対象 record の id。bulk operation（一括メンテ等）は null。
 * - `diff`: 操作前後値の差分 jsonb。例: `{before: {...}, after: {...}}`。
 *   insert は `before` 無し、delete は `after` 無し想定。
 * - `ip_address`: IPv6 対応で 45 文字確保。
 * - `prev_hash`: 先頭行は null。それ以外は直前行の `row_hash`。
 * - `row_hash`: SHA-256 hex（64 文字）。
 *
 * ## 関連
 * - NFR04 (docs/requirements/non-functional/NFR04-audit-log.md)
 * - ADR-019 (RLS 二層) — 本表は cross-tenant、RLS は append-only policy のみ
 * - CLAUDE.md ルール 1 (監査カラム), ルール 4 (PII / LLM 呼び出しの記録)
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    actorUserId: uuid("actor_user_id"),
    actorIdentityUid: varchar("actor_identity_uid", { length: 128 }),
    // cross-tenant 操作（system_admin など）は null
    schoolId: uuid("school_id"),
    tableName: varchar("table_name", { length: 64 }).notNull(),
    // bulk operation は null
    recordId: uuid("record_id"),
    operation: auditOp("operation").notNull(),
    diff: jsonb("diff").notNull().default(sql`'{}'::jsonb`),
    // IPv6 対応で 45 chars
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    // 先頭行は null、それ以外は直前行の row_hash（SHA-256 hex 64 chars）
    prevHash: varchar("prev_hash", { length: 64 }),
    rowHash: varchar("row_hash", { length: 64 }).notNull(),
    ...auditColumns,
  },
  (t) => ({
    ixOccurredAt: index("ix_audit_log_occurred_at").on(t.occurredAt),
    ixTableRecord: index("ix_audit_log_table_record").on(t.tableName, t.recordId),
    ixActor: index("ix_audit_log_actor_user_id").on(t.actorUserId),
    ixSchool: index("ix_audit_log_school_id").on(t.schoolId),
  }),
);
