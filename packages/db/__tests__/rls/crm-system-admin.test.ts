/**
 * CRM 系テーブル (advertisers / contracts / communications / system_admins) の RLS 規律確認。
 *
 * ADR-019 により、これらは **DB レベルでは RLS 対象外** (school_id を持たないため)。
 * よって school_admin role コンテキストで生クエリを投げると **見えてしまう** のが正しい挙動。
 * 「外部からの直アクセスを防ぐのは middleware の役目」をテストでも明文化し、
 * 将来 RLS を追加した際の後方互換破壊を検知できるようにする。
 *
 * 関連: ADR-019, ADR-018, NFR03
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPg, resetData, withTenant } from "../_helpers/postgres.js";

describe("CRM tables are cross-tenant (RLS 対象外)", () => {
  afterAll(async () => {
    const pg = await getSharedPg();
    await pg.cleanup();
  });

  beforeEach(async () => {
    const pg = await getSharedPg();
    await resetData(pg);
  });

  it("advertisers / contracts / communications は school_admin context でも見える (RLS 対象外)", async () => {
    const pg = await getSharedPg();
    const advId = randomUUID();
    const contractId = randomUUID();

    // superuser で fixture 投入
    await pg.admin.unsafe(`
      INSERT INTO advertisers (id, company_name, is_active)
        VALUES ('${advId}', 'Ad Co', true);
      INSERT INTO contracts (id, advertiser_id, status, started_at, monthly_fee_jpy)
        VALUES ('${contractId}', '${advId}', 'active', now(), 50000);
      INSERT INTO communications (advertiser_id, contract_id, channel, occurred_at, subject)
        VALUES ('${advId}', '${contractId}', 'email', now(), 'Welcome');
    `);

    // school_admin context (system_admin ではない) でも直接 SELECT は通る
    // これらは middleware で system_admin チェックされる前提
    const result = await withTenant(
      pg,
      { schoolId: randomUUID(), role: "school_admin" },
      async (sql) => {
        const advs = await sql`SELECT id FROM advertisers`;
        const contracts = await sql`SELECT id FROM contracts`;
        const comms = await sql`SELECT id FROM communications`;
        return { advs, contracts, comms };
      },
    );

    // RLS 対象外なので可視。これらの行を「アプリ層 middleware が止める」のが ADR-018 の責務
    expect(result.advs.length).toBe(1);
    expect(result.contracts.length).toBe(1);
    expect(result.comms.length).toBe(1);
  });

  it("RLS 対象外テーブルは pg_tables.rowsecurity が false である", async () => {
    const pg = await getSharedPg();
    const rows = await pg.admin.unsafe(`
      SELECT tablename, rowsecurity
        FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('advertisers', 'contracts', 'communications', 'system_admins', 'audit_log')
       ORDER BY tablename
    `);

    for (const row of rows as Array<{ tablename: string; rowsecurity: boolean }>) {
      expect(
        row.rowsecurity,
        `${row.tablename} should NOT have RLS enabled (cross-tenant, ADR-019)`,
      ).toBe(false);
    }
  });

  it("RLS 対象テーブルは全て pg_tables.rowsecurity = true", async () => {
    const pg = await getSharedPg();
    const expectedRlsTables = [
      "schools",
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
    ];

    const rows = (await pg.admin.unsafe(`
      SELECT tablename, rowsecurity
        FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename = ANY(ARRAY[${expectedRlsTables.map((t) => `'${t}'`).join(",")}])
       ORDER BY tablename
    `)) as Array<{ tablename: string; rowsecurity: boolean }>;

    expect(rows.length).toBe(expectedRlsTables.length);
    for (const row of rows) {
      expect(row.rowsecurity, `${row.tablename} must have RLS enabled`).toBe(true);
    }
  });
});
