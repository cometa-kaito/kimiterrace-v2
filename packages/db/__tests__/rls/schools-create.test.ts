import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { createSchool } from "../../src/queries/schools.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-L3 (#123): createSchool を実 PG (RLS 込み) で検証する。
 *
 * schools への INSERT は `system_admin_full_access` の WITH CHECK (role=system_admin) でのみ通る。
 * テナント (school_admin/teacher) 向けの INSERT policy は無いため RLS が拒否する (越権防止、ルール2)。
 */
describeOrSkip("#48-L3 createSchool (system_admin のみ INSERT 可 / テナントは RLS 拒否)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    // 本テストが作る学校だけ消す (fixture の schoolA/B は残す)。
    await raw`DELETE FROM schools WHERE name LIKE 'L3テスト%'`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  const input = {
    name: "L3テスト高校",
    prefecture: "岐阜県",
    code: "L3-001",
    hierarchyMode: "class" as const,
    createdBy: null,
  };

  it("system_admin → INSERT 成功、id を返し、行が可視", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) => createSchool(tx, input),
      APP,
    );
    expect(rows).toHaveLength(1);
    const newId = rows[0].id;
    // system_admin context で読み戻せる。
    const visible = await raw`SELECT id, name FROM schools WHERE id = ${newId}`;
    expect(visible).toHaveLength(1);
    expect(visible[0].name).toBe("L3テスト高校");
  });

  it("school_admin → INSERT は RLS (WITH CHECK) で拒否", async () => {
    await expect(
      withTenantContext(
        db,
        { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
        (tx) => createSchool(tx, { ...input, createdBy: fx.userA }),
        APP,
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("teacher → INSERT は RLS で拒否", async () => {
    await expect(
      withTenantContext(
        db,
        { userId: fx.userA, schoolId: fx.schoolA, role: "teacher" },
        (tx) => createSchool(tx, { ...input, createdBy: fx.userA }),
        APP,
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("作成行は監査カラム既定を持つ (created_at/updated_at)", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin" },
      (tx) => createSchool(tx, input),
      APP,
    );
    const [row] = await raw<{ created_at: Date; updated_at: Date }[]>`
      SELECT created_at, updated_at FROM schools WHERE id = ${rows[0].id}
    `;
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });
});
