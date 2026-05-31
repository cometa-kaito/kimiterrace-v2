import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getSchool, updateSchool } from "../../src/queries/schools.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-L (#123): getSchool / updateSchool を実 PG (RLS 込み) で検証する。
 *
 * schools の編集系 policy (0002_rls_policies.sql):
 *   - system_admin_full_access (role=system_admin) → 全校 SELECT/UPDATE 可
 *   - tenant_self_read (id = app.current_school_id) → 自校のみ SELECT
 *   - tenant_isolation_modify (id = app.current_school_id) → 自校のみ UPDATE
 * クエリ関数は WHERE で role/school を書かないため、可視 / 更新可否が context で正しく変わることを
 * 確認する。**越権 (school_admin が他校を更新)** が 0 行で弾かれることを固定する (ルール2)。
 *
 * system_admin は schoolId=null / role=system_admin で `withTenantContext` に入る
 * (app.current_school_id は SET されない)。それでも全校 SELECT/UPDATE できることが横断運用の要。
 */
describeOrSkip("#48-L getSchool / updateSchool (system_admin=全校 / school_admin=自校のみ)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    // テスト間の更新を初期状態に戻す (BYPASSRLS な superuser で直接書き戻す)。
    await raw`UPDATE schools SET name = 'テスト高校 A', hierarchy_mode = 'class' WHERE id = ${fx.schoolA}`;
    await raw`UPDATE schools SET name = 'テスト高校 B', hierarchy_mode = 'class' WHERE id = ${fx.schoolB}`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("system_admin → 任意の学校を getSchool で取得できる (A も B も)", async () => {
    const [a, b] = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      async (tx) => [await getSchool(tx, fx.schoolA), await getSchool(tx, fx.schoolB)],
      APP,
    );
    expect(a?.id).toBe(fx.schoolA);
    expect(b?.id).toBe(fx.schoolB);
    expect(a?.hierarchyMode).toBe("class");
  });

  it("system_admin → 任意の学校を updateSchool で更新できる (横断、school context 無し)", async () => {
    const updated = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) =>
        updateSchool(tx, fx.schoolB, {
          name: "改名B",
          prefecture: "岐阜県",
          code: "B002",
          hierarchyMode: "department",
          updatedBy: null,
        }),
      APP,
    );
    expect(updated.map((r) => r.id)).toEqual([fx.schoolB]);

    const [row] = await raw<{ name: string; hierarchy_mode: string }[]>`
      SELECT name, hierarchy_mode FROM schools WHERE id = ${fx.schoolB}
    `;
    expect(row.name).toBe("改名B");
    expect(row.hierarchy_mode).toBe("department");
  });

  it("school_admin → 自校 (A) を updateSchool で更新できる", async () => {
    const updated = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) =>
        updateSchool(tx, fx.schoolA, {
          name: "改名A",
          prefecture: "岐阜県",
          code: "A001",
          hierarchyMode: "class",
          updatedBy: fx.userA,
        }),
      APP,
    );
    expect(updated.map((r) => r.id)).toEqual([fx.schoolA]);
  });

  it("school_admin → 他校 (B) の updateSchool は 0 行 (越権不可、tenant_isolation_modify)", async () => {
    const updated = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) =>
        updateSchool(tx, fx.schoolB, {
          name: "乗っ取りB",
          prefecture: "岐阜県",
          code: "HACK",
          hierarchyMode: "department",
          updatedBy: fx.userA,
        }),
      APP,
    );
    expect(updated).toEqual([]);

    // 実際に他校が書き換わっていないことを確認 (RLS が UPDATE を弾いた)。
    const [row] = await raw<{ name: string }[]>`SELECT name FROM schools WHERE id = ${fx.schoolB}`;
    expect(row.name).toBe("テスト高校 B");
  });

  it("school_admin → 他校 (B) の getSchool は不可視 (undefined)", async () => {
    const row = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) => getSchool(tx, fx.schoolB),
      APP,
    );
    expect(row).toBeUndefined();
  });

  it("school context 未設定のテナント role → getSchool は 0 件 (deny-by-default)", async () => {
    const row = await withTenantContext(
      db,
      { userId: fx.userA, role: "school_admin" },
      (tx) => getSchool(tx, fx.schoolA),
      APP,
    );
    expect(row).toBeUndefined();
  });
});
