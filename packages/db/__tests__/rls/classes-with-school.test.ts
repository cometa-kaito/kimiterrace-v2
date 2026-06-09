import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { listClassesWithSchool } from "../../src/queries/schools.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * C方式 TV プロビジョニング: `listClassesWithSchool`（school→class カスケード源）が RLS を尊重することを
 * 実 PG で検証する。system_admin は全校のクラスを所属校つきで見、school テナントは自校のクラスのみ見る
 * （`classes` の tenant_isolation / system_admin_full_access、手書き WHERE 無し、ルール2）。
 */
describeOrSkip("RLS: listClassesWithSchool", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    await sql`RESET ROLE`;
    await sql`INSERT INTO classes (school_id, academic_year, name, grade) VALUES (${fx.schoolA}, 2026, 'prov-A-1組', 1)`;
    await sql`INSERT INTO classes (school_id, academic_year, name, grade) VALUES (${fx.schoolB}, 2026, 'prov-B-1組', 1)`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("system_admin は全校のクラスを所属校 id つきで見る", async () => {
    const rows = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => listClassesWithSchool(tx),
      APP,
    );
    const schoolIds = new Set(rows.map((r) => r.schoolId));
    expect(schoolIds.has(fx.schoolA)).toBe(true);
    expect(schoolIds.has(fx.schoolB)).toBe(true);
    // 射影に schoolId が載っている（カスケードのキー）。
    expect(rows.every((r) => typeof r.schoolId === "string" && typeof r.name === "string")).toBe(
      true,
    );
  });

  it("school A テナントは自校のクラスのみ（他校不可視、RLS）", async () => {
    const rows = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin" },
      (tx) => listClassesWithSchool(tx),
      APP,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.schoolId === fx.schoolA)).toBe(true);
  });

  it("context 未設定 → 0 件（deny by default）", async () => {
    const rows = await withTenantContext(db, {}, (tx) => listClassesWithSchool(tx), APP);
    expect(rows.length).toBe(0);
  });
});
