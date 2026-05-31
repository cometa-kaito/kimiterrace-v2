import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getSchoolDetail } from "../../src/queries/schools.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-L2 (#123): getSchoolDetail を実 PG (RLS 込み) で検証する。
 *
 * 検証点:
 * - system_admin は任意校の詳細 + 配下件数を取得できる (system_admin_full_access)。
 * - 件数は対象校に絞り込まれる (他校の学年/クラス/学科を混ぜない)。
 * - テナント (school_admin) は自校のみ、他校 id は null (tenant_self_read)。
 * - 不存在 id は null。
 */
describeOrSkip("#48-L2 getSchoolDetail (マスタ + 階層件数 / RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    // 各校の配下階層を作り直す (BYPASSRLS superuser で直接投入)。
    await raw`DELETE FROM classes`;
    await raw`DELETE FROM grades`;
    await raw`DELETE FROM departments`;
    // schoolA: 学年 2 / クラス 3 / 学科 1
    await raw`INSERT INTO grades (school_id, name) VALUES (${fx.schoolA}, '1年'), (${fx.schoolA}, '2年')`;
    await raw`INSERT INTO departments (school_id, name) VALUES (${fx.schoolA}, '普通科')`;
    await raw`
      INSERT INTO classes (school_id, academic_year, name, grade)
      VALUES (${fx.schoolA}, 2026, 'A組', 1), (${fx.schoolA}, 2026, 'B組', 1), (${fx.schoolA}, 2026, 'C組', 2)
    `;
    // schoolB: 学年 1 / クラス 1 (件数が混ざらないことの対照)
    await raw`INSERT INTO grades (school_id, name) VALUES (${fx.schoolB}, '1年')`;
    await raw`INSERT INTO classes (school_id, academic_year, name, grade) VALUES (${fx.schoolB}, 2026, 'A組', 1)`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("system_admin → 任意校 (A) の詳細 + 対象校に絞った件数", async () => {
    const detail = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) => getSchoolDetail(tx, fx.schoolA),
      APP,
    );
    expect(detail).not.toBeNull();
    expect(detail?.school.id).toBe(fx.schoolA);
    // A の件数のみ (B の 学年1/クラス1 を混ぜない)。
    expect(detail?.counts).toEqual({ grades: 2, classes: 3, departments: 1 });
  });

  it("system_admin → 別校 (B) は B の件数だけ", async () => {
    const detail = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) => getSchoolDetail(tx, fx.schoolB),
      APP,
    );
    expect(detail?.school.id).toBe(fx.schoolB);
    expect(detail?.counts).toEqual({ grades: 1, classes: 1, departments: 0 });
  });

  it("school_admin (A) → 自校詳細は取得できる", async () => {
    const detail = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) => getSchoolDetail(tx, fx.schoolA),
      APP,
    );
    expect(detail?.school.id).toBe(fx.schoolA);
    expect(detail?.counts.classes).toBe(3);
  });

  it("school_admin (A) → 他校 (B) は null (tenant_self_read で不可視)", async () => {
    const detail = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) => getSchoolDetail(tx, fx.schoolB),
      APP,
    );
    expect(detail).toBeNull();
  });

  it("不存在 id → null", async () => {
    const detail = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) => getSchoolDetail(tx, "00000000-0000-4000-8000-000000000000"),
      APP,
    );
    expect(detail).toBeNull();
  });
});
