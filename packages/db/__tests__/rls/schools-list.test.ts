import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { listSchools } from "../../src/queries/schools.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-L (#123): listSchools を実 PG (RLS 込み) で検証する。
 *
 * schools には 2 policy がある (0002_rls_policies.sql):
 *   - system_admin_full_access (role=system_admin) → 全校可視
 *   - tenant_self_read (id = app.current_school_id) → 自校 1 件のみ
 * listSchools は WHERE を書かず RLS に委ねるため、可視範囲が context で正しく変わることを確認する。
 * クエリ関数そのものを `withTenantContext` 経由で実行し、射影 / 並び / テナント分離を突き合わせる。
 */
describeOrSkip("#48-L listSchools (system_admin=全校 / テナント=自校 / deny-by-default)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("system_admin role → 全校可視 (schoolA + schoolB を含む 2 校以上)", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) => listSchools(tx),
      APP,
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(fx.schoolA);
    expect(ids).toContain(fx.schoolB);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("射影は軽量 (id/name/prefecture/code/createdAt のみ、notes 非含)", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) => listSchools(tx),
      APP,
    );
    expect(Object.keys(rows[0]).sort()).toEqual(["code", "createdAt", "id", "name", "prefecture"]);
  });

  it("並びが (prefecture, name, id) で決定的に昇順", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) => listSchools(tx),
      APP,
    );
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const ascending =
        prev.prefecture < cur.prefecture ||
        (prev.prefecture === cur.prefecture && prev.name <= cur.name);
      expect(ascending, `行 ${i} の並びが昇順でない`).toBe(true);
    }
  });

  it("school_admin role → 自校 1 件のみ (tenant_self_read)", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) => listSchools(tx),
      APP,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(fx.schoolA);
  });

  it("teacher role + schoolB → 自校 (B) 1 件のみ、A は不可視", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.userB, schoolId: fx.schoolB, role: "teacher" },
      (tx) => listSchools(tx),
      APP,
    );
    expect(rows.map((r) => r.id)).toEqual([fx.schoolB]);
  });

  it("school context 未設定のテナント role → 0 件 (deny-by-default)", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.userA, role: "school_admin" },
      (tx) => listSchools(tx),
      APP,
    );
    expect(rows.length).toBe(0);
  });
});
