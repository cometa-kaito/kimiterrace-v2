import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantScopedContext, withTenantContext } from "../../src/client.js";
import { findVisibleClass } from "../../src/queries/ads.js";
import { classes } from "../../src/schema/index.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * ADR-019 §#95 / Issue #226: quiet_hours 設定 (`saveQuietHoursAction`) の cross-tenant ガードが
 * system_admin でも効くことを実 PG で固定する。
 *
 * `saveQuietHoursAction` は書き込み前に `findVisibleClass(tx, classId)` で対象クラスが**自校で
 * 可視か**を確認する (#73 の多層防御)。`classes` は `tenant_isolation` + `system_admin_full_access`
 * の二層 RLS のため、actor=system_admin (school_id 有り) の tx では full_access policy が全校発火し
 * `findVisibleClass` が他校 class も可視 (非 null) と判定 → ガードをすり抜けて他校クラスに静粛時間を
 * ぶら下げられた (#197 hub-actions と同種の gap)。
 *
 * Server Action は `withSession(..., { tenantScoped: true })` で system_admin を school_admin に降格
 * する。降格すると full_access が止まり `tenant_isolation` だけが残るため `findVisibleClass` は他校
 * class を不可視 (null) と判定し、ガードが正しく cross-tenant を弾く。
 *
 * 「降格なし (raw system_admin)」と「降格あり (tenantScopedContext)」を**対比**し、降格こそが
 * 他校遮断を生んでいる (= テストが空虚でない) ことを実証する。gap は `school_configs` ではなく
 * Action が実際に使う `findVisibleClass` (= `classes` 可視性) 側にあるため、そこを直接突く
 * (`school_configs` は tenant_isolation のみで full_access policy を持たず、元から他校不可視)。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("#226 quiet_hours の cross-tenant ガード × system_admin 降格 (実 PG)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
  const sql = createSql(url!);
  const db = drizzle(sql);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;
  let classB: string;

  // 接続はテスト superuser のため withTenantContext の appRole で kimiterrace_app に降格して RLS を効かせる。
  const APP = { appRole: "kimiterrace_app" } as const;
  // system_admin (school A を選択中) の RLS コンテキスト。beforeAll で id を埋める。
  const sysAdminA = { userId: "", role: "system_admin" as const, schoolId: "" };

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    sysAdminA.userId = fx.sysAdmin;
    sysAdminA.schoolId = fx.schoolA;
    classA = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, name, academic_year, grade)
        VALUES (${fx.schoolA}, '1-A', 2026, 1) RETURNING id`
    )[0].id;
    classB = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, name, academic_year, grade)
        VALUES (${fx.schoolB}, '1-B', 2026, 1) RETURNING id`
    )[0].id;
  }, 30000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // UPDATE テストで classB.name を書き換えるため、各テスト前に両校の class 名を既定へ戻す。
  beforeEach(async () => {
    await sql`UPDATE classes SET name = '1-A' WHERE id = ${classA}`;
    await sql`UPDATE classes SET name = '1-B' WHERE id = ${classB}`;
  });

  it("降格なし (raw system_admin) は findVisibleClass が他校 class を可視と誤判定 = 旧来の越権経路", async () => {
    const visible = await withTenantContext(
      db,
      sysAdminA,
      (tx) => findVisibleClass(tx, classB),
      APP,
    );
    expect(visible).not.toBeNull(); // system_admin_full_access が全校発火 → ガードすり抜け
  });

  it("降格あり (tenantScopedContext) は findVisibleClass が他校 class を不可視と正しく判定", async () => {
    const visible = await withTenantContext(
      db,
      tenantScopedContext(sysAdminA),
      (tx) => findVisibleClass(tx, classB),
      APP,
    );
    expect(visible).toBeNull(); // tenant_isolation のみ残り他校は不可視 → ガードが弾く
  });

  it("降格あり でも自校 class は可視 (過剰ブロックしない)", async () => {
    const visible = await withTenantContext(
      db,
      tenantScopedContext(sysAdminA),
      (tx) => findVisibleClass(tx, classA),
      APP,
    );
    expect(visible).not.toBeNull();
  });

  it("降格あり は他校 class を UPDATE できない (USING で 0 行、他校は不変)", async () => {
    await withTenantContext(
      db,
      tenantScopedContext(sysAdminA),
      (tx) => tx.update(classes).set({ name: "乗っ取り" }).where(eq(classes.id, classB)),
      APP,
    );
    const after = await sql<{ name: string }[]>`SELECT name FROM classes WHERE id = ${classB}`;
    expect(after[0]?.name).toBe("1-B"); // 他校行は不可視のため変更されない
  });

  it("降格なし は他校 class を UPDATE できてしまう (対比 = 降格の効果を実証)", async () => {
    await withTenantContext(
      db,
      sysAdminA,
      (tx) => tx.update(classes).set({ name: "乗っ取り" }).where(eq(classes.id, classB)),
      APP,
    );
    const after = await sql<{ name: string }[]>`SELECT name FROM classes WHERE id = ${classB}`;
    expect(after[0]?.name).toBe("乗っ取り"); // full_access が効き他校を書き換えられる
  });
});
