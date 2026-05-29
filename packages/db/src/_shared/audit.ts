import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * CLAUDE.md ルール1: 全テーブルに監査カラムを必ず付ける。
 *
 * - created_at / updated_at: タイムスタンプ
 * - created_by / updated_by: users.id への参照（nullable: システム作成・移行は null）
 *
 * 参照先 users テーブルとの循環依存を避けるため、ここでは FK 制約は付けず uuid のみ宣言する。
 * 物理的な FK は migration で `ALTER TABLE ... ADD CONSTRAINT` する想定（packages/db/rls/ に付随）。
 */
export const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now()`),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
} as const;

/** 監査カラムのキー名（テストでの存在検証に使う） */
export const AUDIT_COLUMN_KEYS = ["createdAt", "updatedAt", "createdBy", "updatedBy"] as const;
