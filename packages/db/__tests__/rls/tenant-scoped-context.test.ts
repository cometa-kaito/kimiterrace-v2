import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantScopedContext, withTenantContext } from "../../src/client.js";
import { departments } from "../../src/schema/index.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * ADR-019 §#95 / Issue #197: テナントスコープ操作での system_admin 降格を検証する。
 *
 * `tenantScopedContext` が system_admin (+schoolId) を school_admin に降格すると、
 * `system_admin_full_access` policy (`app.current_user_role = 'system_admin'` で全校 PERMISSIVE
 * 発火) が無効化され、`tenant_isolation` (`school_id = app.current_school_id`) だけが残るため
 * 他校行が不可視になる。これにより自校可視性チェック (existsInSchool, #73) が system_admin でも
 * すり抜けなくなる。
 *
 * 「降格あり」と「降格なし (raw system_admin)」を**対比**し、降格こそが他校不可視化を生んでいる
 * (= テストが空虚でない) ことを実 PG で実証する。
 */

describe("tenantScopedContext (純粋関数, ADR-019 §#95)", () => {
  const sid = "11111111-1111-4111-8111-111111111111";
  const uid = "22222222-2222-4222-8222-222222222222";

  it("system_admin + schoolId → school_admin に降格する", () => {
    expect(tenantScopedContext({ userId: uid, role: "system_admin", schoolId: sid })).toEqual({
      userId: uid,
      role: "school_admin",
      schoolId: sid,
    });
  });

  it("system_admin + schoolId=null → 降格しない (全校横断経路を保つ)", () => {
    expect(tenantScopedContext({ userId: uid, role: "system_admin", schoolId: null })).toEqual({
      userId: uid,
      role: "system_admin",
      schoolId: null,
    });
  });

  it("tenant ロール (school_admin) → そのまま (full_access policy 非該当)", () => {
    const ctx = { userId: uid, role: "school_admin" as const, schoolId: sid };
    expect(tenantScopedContext(ctx)).toEqual(ctx);
  });
});

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("#197 system_admin 降格 RLS (departments, 実 PG)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
  const sql = createSql(url!);
  const db = drizzle(sql);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let deptA: string;
  let deptB: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校に学科 1 件 (BYPASSRLS = 所有者接続で直接 INSERT)。
    deptA = (
      await sql<{ id: string }[]>`
        INSERT INTO departments (school_id, name, display_order)
        VALUES (${fx.schoolA}, 'A学科', 1) RETURNING id`
    )[0].id;
    deptB = (
      await sql<{ id: string }[]>`
        INSERT INTO departments (school_id, name, display_order)
        VALUES (${fx.schoolB}, 'B学科', 1) RETURNING id`
    )[0].id;
  }, 20000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // 接続はテスト superuser のため withTenantContext の appRole で kimiterrace_app に降格して RLS を効かせる。
  const APP = { appRole: "kimiterrace_app" } as const;

  it("降格なし (raw system_admin) は他校 department が可視 = 旧来の越権経路", async () => {
    const rows = await withTenantContext(
      db,
      { userId: fx.sysAdmin, role: "system_admin", schoolId: fx.schoolA },
      (tx) => tx.select().from(departments).where(eq(departments.id, deptB)),
      APP,
    );
    expect(rows).toHaveLength(1); // system_admin_full_access が全校発火
  });

  it("降格あり (tenantScopedContext) は他校 department が不可視", async () => {
    const rows = await withTenantContext(
      db,
      tenantScopedContext({ userId: fx.sysAdmin, role: "system_admin", schoolId: fx.schoolA }),
      (tx) => tx.select().from(departments).where(eq(departments.id, deptB)),
      APP,
    );
    expect(rows).toHaveLength(0); // tenant_isolation のみ残り他校は不可視
  });

  it("降格あり でも自校 department は可視 (過剰ブロックしない)", async () => {
    const rows = await withTenantContext(
      db,
      tenantScopedContext({ userId: fx.sysAdmin, role: "system_admin", schoolId: fx.schoolA }),
      (tx) => tx.select().from(departments).where(eq(departments.id, deptA)),
      APP,
    );
    expect(rows).toHaveLength(1);
  });

  it("降格あり は他校 department を UPDATE できない (USING で 0 行、他校は不変)", async () => {
    await withTenantContext(
      db,
      tenantScopedContext({ userId: fx.sysAdmin, role: "system_admin", schoolId: fx.schoolA }),
      (tx) => tx.update(departments).set({ name: "乗っ取り" }).where(eq(departments.id, deptB)),
      APP,
    );
    const after = await sql<{ name: string }[]>`select name from departments where id = ${deptB}`;
    expect(after[0]?.name).toBe("B学科"); // 他校行は不可視のため変更されない
  });
});
