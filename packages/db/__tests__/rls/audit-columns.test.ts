/**
 * CLAUDE.md ルール 1: 全テーブルに監査カラム (`created_at`/`updated_at`/`created_by`/`updated_by`) が存在する。
 *
 * information_schema.columns を引いて、`public` schema の全テーブルに対し
 * AUDIT_COLUMN_KEYS の snake_case 名 4 つすべてが存在することを assert する。
 */
import { afterAll, describe, expect, it } from "vitest";
import { getSharedPg } from "../_helpers/postgres.js";

const REQUIRED_COLUMNS = ["created_at", "updated_at", "created_by", "updated_by"] as const;

// drizzle_migrations はマイグレーション追跡用の内部テーブルなので対象外
const EXCLUDED_TABLES = new Set(["drizzle_migrations"]);

describe("All tables have audit columns (CLAUDE.md rule 1)", () => {
  afterAll(async () => {
    const pg = await getSharedPg();
    await pg.cleanup();
  });

  it("全 public テーブルに created_at/updated_at/created_by/updated_by がある", async () => {
    const pg = await getSharedPg();

    const rows = (await pg.admin.unsafe(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, column_name
    `)) as Array<{ table_name: string; column_name: string }>;

    // テーブルごとにカラム集合を作る
    const byTable = new Map<string, Set<string>>();
    for (const r of rows) {
      if (EXCLUDED_TABLES.has(r.table_name)) continue;
      const set = byTable.get(r.table_name) ?? new Set<string>();
      set.add(r.column_name);
      byTable.set(r.table_name, set);
    }

    // 想定: 業務テーブルが 18 個（schools + RLS 対象 12 + CRM 4 + audit_log）
    expect(byTable.size).toBeGreaterThanOrEqual(18);

    const missing: Array<{ table: string; column: string }> = [];
    for (const [table, columns] of byTable) {
      for (const required of REQUIRED_COLUMNS) {
        if (!columns.has(required)) {
          missing.push({ table, column: required });
        }
      }
    }

    expect(missing, `Missing audit columns: ${JSON.stringify(missing)}`).toEqual([]);
  });
});
