import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantScopedContext } from "../../src/client";
import { departments } from "../../src/schema";
import { getTestDb, rawSql, withTenantContext } from "../_setup/db";

/**
 * ADR-019 §#95 / Issue #197: テナントスコープ操作での system_admin 降格の RLS テスト。
 *
 * `tenantScopedContext` が system_admin (+schoolId) を school_admin に降格すると、
 * `system_admin_full_access` policy (`app.role = 'system_admin'` で全校 PERMISSIVE 発火) が
 * 無効化され、`tenant_isolation` (`school_id = app.school_id`) だけが残るため他校行が不可視になる。
 * これにより自校可視性チェック (existsInSchool, #73) が system_admin でもすり抜けなくなる。
 *
 * 「降格あり」と「降格なし (raw system_admin)」を**対比**し、降格こそが他校不可視化を生んでいる
 * (= テストが空虚でない) ことを実 PG で実証する。
 *
 * ADR-012: 実 PostgreSQL に対してテスト。DATABASE_URL 必須。
 */

const schoolA = randomUUID();
const schoolB = randomUUID();
const sysAdmin = randomUUID();
const deptA = randomUUID();
const deptB = randomUUID();

async function seedSchool(id: string): Promise<void> {
  await rawSql`
    insert into schools (id, name, prefecture, created_by, updated_by)
    values (${id}, ${`school-${id.slice(0, 8)}`}, ${"東京都"}, ${sysAdmin}, ${sysAdmin})
  `;
}

async function seedDept(id: string, schoolId: string, name: string): Promise<void> {
  await rawSql`
    insert into departments (id, school_id, name, created_by, updated_by)
    values (${id}, ${schoolId}, ${name}, ${sysAdmin}, ${sysAdmin})
  `;
}

beforeAll(async () => {
  await seedSchool(schoolA);
  await seedSchool(schoolB);
}, 20000);

afterAll(async () => {
  await rawSql`delete from departments where school_id in (${schoolA}, ${schoolB})`;
  await rawSql`delete from schools where id in (${schoolA}, ${schoolB})`;
}, 20000);

beforeEach(async () => {
  // 各テストの前に両校の department を作り直す (UPDATE 系テストの相互汚染を防ぐ)。
  await rawSql`delete from departments where school_id in (${schoolA}, ${schoolB})`;
  await seedDept(deptA, schoolA, "A学科");
  await seedDept(deptB, schoolB, "B学科");
});

describe("tenantScopedContext (純粋関数, ADR-019 §#95)", () => {
  it("system_admin + schoolId → school_admin に降格する", () => {
    expect(
      tenantScopedContext({ userId: sysAdmin, role: "system_admin", schoolId: schoolA }),
    ).toEqual({ userId: sysAdmin, role: "school_admin", schoolId: schoolA });
  });

  it("system_admin + schoolId=null → 降格しない (全校横断経路を保つ)", () => {
    expect(tenantScopedContext({ userId: sysAdmin, role: "system_admin", schoolId: null })).toEqual(
      { userId: sysAdmin, role: "system_admin", schoolId: null },
    );
  });

  it("tenant ロール (school_admin) → そのまま (full_access policy 非該当)", () => {
    const ctx = { userId: sysAdmin, role: "school_admin" as const, schoolId: schoolA };
    expect(tenantScopedContext(ctx)).toEqual(ctx);
  });
});

describe("#197 system_admin 降格 RLS (departments, 実 PG)", () => {
  it("降格なし (raw system_admin) は他校 department が可視 = 旧来の越権経路", async () => {
    const rows = await withTenantContext(
      getTestDb(),
      { userId: sysAdmin, role: "system_admin", schoolId: schoolA },
      (tx) => tx.select().from(departments).where(eq(departments.id, deptB)),
    );
    expect(rows).toHaveLength(1); // system_admin_full_access が全校発火
  });

  it("降格あり (tenantScopedContext) は他校 department が不可視", async () => {
    const rows = await withTenantContext(
      getTestDb(),
      tenantScopedContext({ userId: sysAdmin, role: "system_admin", schoolId: schoolA }),
      (tx) => tx.select().from(departments).where(eq(departments.id, deptB)),
    );
    expect(rows).toHaveLength(0); // tenant_isolation のみ残り他校は不可視
  });

  it("降格あり でも自校 department は可視 (過剰ブロックしない)", async () => {
    const rows = await withTenantContext(
      getTestDb(),
      tenantScopedContext({ userId: sysAdmin, role: "system_admin", schoolId: schoolA }),
      (tx) => tx.select().from(departments).where(eq(departments.id, deptA)),
    );
    expect(rows).toHaveLength(1);
  });

  it("降格あり は他校 department を UPDATE できない (USING で 0 行)", async () => {
    await withTenantContext(
      getTestDb(),
      tenantScopedContext({ userId: sysAdmin, role: "system_admin", schoolId: schoolA }),
      (tx) => tx.update(departments).set({ name: "乗っ取り" }).where(eq(departments.id, deptB)),
    );
    const after = await rawSql<{ name: string }>`select name from departments where id = ${deptB}`;
    expect(after[0]?.name).toBe("B学科"); // 他校行は不可視のため変更されない
  });

  it("降格なし は他校 department を UPDATE できてしまう (対比 = 降格の効果を実証)", async () => {
    await withTenantContext(
      getTestDb(),
      { userId: sysAdmin, role: "system_admin", schoolId: schoolA },
      (tx) => tx.update(departments).set({ name: "乗っ取り" }).where(eq(departments.id, deptB)),
    );
    const after = await rawSql<{ name: string }>`select name from departments where id = ${deptB}`;
    expect(after[0]?.name).toBe("乗っ取り"); // full_access が効き他校を書き換えられる
  });
});
