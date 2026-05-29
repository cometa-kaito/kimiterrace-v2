/**
 * RLS tenant_isolation 4 ケース:
 *   1. 自 school_id コンテキスト → 自校データのみ可視
 *   2. 別 school_id コンテキスト → 自校 0 件
 *   3. context 未設定 (NULL) → fail-closed で 0 件
 *   4. system_admin role → 全 school_id 可視
 *
 * 関連: ADR-019, CLAUDE.md ルール 2
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedTwoSchools } from "../_helpers/fixtures.js";
import { getSharedPg, resetData, withTenant } from "../_helpers/postgres.js";

describe("RLS tenant_isolation on users", () => {
  afterAll(async () => {
    const pg = await getSharedPg();
    await pg.cleanup();
  });

  beforeEach(async () => {
    const pg = await getSharedPg();
    await resetData(pg);
  });

  it("自 school_id コンテキストで自校 users が見える", async () => {
    const pg = await getSharedPg();
    const { a } = await seedTwoSchools(pg);

    const rows = await withTenant(pg, { schoolId: a.schoolId, role: "teacher" }, async (sql) => {
      return await sql`SELECT id, school_id, display_name FROM users`;
    });

    expect(rows.length).toBe(1);
    expect(rows[0]?.school_id).toBe(a.schoolId);
    expect(rows[0]?.display_name).toBe("Teacher A");
  });

  it("別 school_id コンテキストでは他校 users が見えない", async () => {
    const pg = await getSharedPg();
    const { a, b } = await seedTwoSchools(pg);

    // school_b の context で school_a の user は見えない
    const rows = await withTenant(pg, { schoolId: b.schoolId, role: "teacher" }, async (sql) => {
      return await sql`SELECT id FROM users WHERE id = ${a.userId}`;
    });

    expect(rows.length).toBe(0);
  });

  it("current_setting('app.current_school_id', true) 未設定なら fail-closed (0 件)", async () => {
    const pg = await getSharedPg();
    await seedTwoSchools(pg);

    // role も school_id も未設定 → tenant_isolation は false、system_admin_full_access も false
    const rows = await withTenant(pg, {}, async (sql) => {
      return await sql`SELECT id FROM users`;
    });

    expect(rows.length).toBe(0);
  });

  it("system_admin role は cross-tenant に全件参照可", async () => {
    const pg = await getSharedPg();
    const { a, b } = await seedTwoSchools(pg);

    // schoolId は未設定で OK、system_admin_full_access policy が通る
    const rows = await withTenant(pg, { role: "system_admin" }, async (sql) => {
      return await sql`SELECT id, school_id FROM users ORDER BY school_id`;
    });

    expect(rows.length).toBe(2);
    const ids = rows.map((r) => r.school_id).sort();
    expect(ids).toEqual([a.schoolId, b.schoolId].sort());
  });
});
