import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { auditOp } from "../_shared/enums.js";

/**
 * NFR04: 全テーブル横断の append-only 監査ログ。
 *
 * 横断テーブル（`school_id` を持たない）。**append-only** 運用とし、改竄検知のため
 * `prev_hash` / `row_hash` でハッシュ連鎖（blockchain 様）を構成する。
 *
 * 改竄検知の仕様（Part C2 の trigger 側で実装）:
 * - `row_hash` = SHA-256(prev_hash || table_name || record_id || operation || diff || occurred_at)
 * - `prev_hash` = 直前ログの `row_hash`。空テーブルの最初の行のみ "" (空文字)。
 * - 検証バッチが `prev_hash` 連鎖の整合性を定期確認する。
 *
 * `diff` は JSON Patch 形式相当（before/after の差分）。生 PII を含む可能性があるため、
 * バックアップ/エクスポート時はマスキング処理を通すこと（CLAUDE.md ルール4）。
 *
 * 注: このテーブル自体への INSERT は trigger 経由のみ。アプリから直接 UPDATE/DELETE 不可
 * （Part C2 で RLS + REVOKE 設定）。`auditColumns` は他テーブルと統一するため付与するが、
 * `created_by` / `updated_by` は実質 trigger 起動 SQL の current_user で固定される。
 *
 * 関連: NFR04 (docs/requirements/non-functional/NFR04-audit-log.md), ADR-019
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // 操作主体（users.id への論理参照、横断テーブルのため FK なし）。
    // バッチ・migration 等の自動実行は null。
    actorUserId: uuid("actor_user_id"),
    // 操作元 IP（IPv4/IPv6 文字列）
    actorIp: varchar("actor_ip", { length: 45 }),
    actorUserAgent: varchar("actor_user_agent", { length: 512 }),
    // 対象テーブル名（例: "schedules", "contents"）
    tableName: varchar("table_name", { length: 64 }).notNull(),
    // 対象行 ID（uuid 以外の PK はサポート対象外）
    recordId: uuid("record_id").notNull(),
    operation: auditOp("operation").notNull(),
    // before/after の差分（JSON Patch 相当）
    diff: jsonb("diff").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().default(sql`now()`),
    // ハッシュ連鎖（改竄検知）。詳細は file header コメント参照。
    prevHash: varchar("prev_hash", { length: 64 }).notNull().default(""),
    rowHash: varchar("row_hash", { length: 64 }).notNull(),
    ...auditColumns,
  },
  (t) => ({
    // 対象テーブル+行での検索（漏洩時の影響範囲特定）
    ixTableRecord: index("ix_audit_log_table_record").on(t.tableName, t.recordId),
    // 時系列スキャン（連鎖検証バッチ）
    ixOccurred: index("ix_audit_log_occurred_at").on(t.occurredAt),
    // 操作主体での絞り込み
    ixActor: index("ix_audit_log_actor_user_id").on(t.actorUserId),
  }),
);
