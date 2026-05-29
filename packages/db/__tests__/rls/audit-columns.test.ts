import { describe, expect, it } from "vitest";
import { createSql, getConnectionUrl } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * CLAUDE.md ルール 1: 全テーブルに監査カラム必須。
 *
 * 検証対象: `created_at` / `updated_at` / `created_by` / `updated_by`。
 *
 * - `*_at` は `timestamp NOT NULL DEFAULT now()`
 * - `*_by` は `uuid` (nullable: システム起因の操作は null) で `users.id` への FK
 *
 * audit_log も例外なし。append-only でも `updated_at` は invariant (created_at と同値) として
 * 物理的に存在する必要がある (ルール 1 の「例外なく」を機械的に保証するため)。
 */
const AUDITED_TABLES = [
  // テナント分離テーブル
  "users",
  "classes",
  "memberships",
  "magic_links",
  "contents",
  "content_versions",
  "publishes",
  "events",
  "ai_extractions",
  "ai_chat_sessions",
  "ai_chat_messages",
  "monthly_reports",
  // CRM / cross-tenant テーブル
  "schools",
  "advertisers",
  "contracts",
  "communications",
  "system_admins",
  // 監査台帳本体 (append-only でも 4 カラムは必須)
  "audit_log",
] as const;

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

describeOrSkip("CLAUDE.md ルール 1: 全テーブルに監査カラム", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);

  it("AUDITED_TABLES の全テーブルが public スキーマに存在する", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const present = new Set(rows.map((r) => r.table_name));
    for (const t of AUDITED_TABLES) {
      expect(present.has(t), `expected table '${t}' to exist`).toBe(true);
    }
  });

  it("各テーブルに created_at / updated_at が NOT NULL で存在する", async () => {
    const rows = await sql<ColumnRow[]>`
      SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN ('created_at', 'updated_at')
         AND table_name = ANY(${sql.array(AUDITED_TABLES as unknown as string[])})
    `;
    const byTable: Record<string, Record<string, ColumnRow>> = {};
    for (const r of rows) {
      byTable[r.table_name] ??= {};
      byTable[r.table_name][r.column_name] = r;
    }
    for (const t of AUDITED_TABLES) {
      const ca = byTable[t]?.created_at;
      const ua = byTable[t]?.updated_at;
      expect(ca, `${t}.created_at missing`).toBeDefined();
      expect(ua, `${t}.updated_at missing`).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: 上で defined を確認済
      expect(ca!.is_nullable, `${t}.created_at must be NOT NULL`).toBe("NO");
      // biome-ignore lint/style/noNonNullAssertion: 上で defined を確認済
      expect(ua!.is_nullable, `${t}.updated_at must be NOT NULL`).toBe("NO");
      // timestamp 系であること
      // biome-ignore lint/style/noNonNullAssertion: 上で defined を確認済
      expect(ca!.data_type).toMatch(/timestamp/);
    }
  });

  it("各テーブルに created_by / updated_by が uuid 型で存在する (nullable 許容)", async () => {
    const rows = await sql<ColumnRow[]>`
      SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN ('created_by', 'updated_by')
         AND table_name = ANY(${sql.array(AUDITED_TABLES as unknown as string[])})
    `;
    const byTable: Record<string, Record<string, ColumnRow>> = {};
    for (const r of rows) {
      byTable[r.table_name] ??= {};
      byTable[r.table_name][r.column_name] = r;
    }
    for (const t of AUDITED_TABLES) {
      const cb = byTable[t]?.created_by;
      const ub = byTable[t]?.updated_by;
      expect(cb, `${t}.created_by missing`).toBeDefined();
      expect(ub, `${t}.updated_by missing`).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: 上で defined を確認済
      expect(cb!.data_type, `${t}.created_by must be uuid`).toBe("uuid");
      // biome-ignore lint/style/noNonNullAssertion: 上で defined を確認済
      expect(ub!.data_type, `${t}.updated_by must be uuid`).toBe("uuid");
    }
  });

  it("`created_by` / `updated_by` は users(id) を参照する FK を持つ", async () => {
    // information_schema 経由で参照テーブルを確認
    const rows = await sql<
      {
        table_name: string;
        column_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
      }[]
    >`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name  AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND kcu.column_name IN ('created_by', 'updated_by')
    `;
    // テーブル × カラムごとに参照先テーブルを集計
    const seen = new Map<string, string>();
    for (const r of rows) {
      seen.set(
        `${r.table_name}.${r.column_name}`,
        `${r.foreign_table_name}.${r.foreign_column_name}`,
      );
    }
    for (const t of AUDITED_TABLES) {
      const cb = seen.get(`${t}.created_by`);
      const ub = seen.get(`${t}.updated_by`);
      expect(cb, `${t}.created_by FK 未設定`).toBe("users.id");
      expect(ub, `${t}.updated_by FK 未設定`).toBe("users.id");
    }
  });
});
