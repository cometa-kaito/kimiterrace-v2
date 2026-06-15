import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classes, departments, grades } from "../../src/schema/index.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-K2 (PR #164 Reviewer M-1): 学校管理者ハブ update/delete の RLS 越境を実 PG で固定する。
 *
 * Server Action 層は「対象再取得 (existsInSchool) → mutation」「子参照カウント」を**自校 RLS tx 内**で
 * 行う。本テストはその土台が DB レベルで効くことを検証する:
 *
 * - existsInSchool 相当 (自校で可視か): 他校 department_id / grade_id を A context で引くと 0 件
 *   → Server Action は cross-tenant 拒否 (CrossTenantError / HubNotFoundError) になる。
 * - 子参照カウント (countGradesInDepartment / countClassesInGrade) も RLS 越境で他校の子を数えない。
 * - UPDATE / DELETE は自校行のみ反映、他校 id を WHERE しても RLS で 0 行 (越境改変不可)。
 */
describeOrSkip("RLS: ハブ update/delete 越境 (#48-K2 M-1)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let deptA: string;
  let deptB: string;
  let gradeA: string;
  let gradeB: string;
  let classA: string;

  /** RLS context (kimiterrace_app + school + role) を張った max:1 接続で fn を実行する。 */
  async function asSchool<T>(
    schoolId: string,
    fn: (db: ReturnType<typeof drizzle>) => Promise<T>,
    role = "school_admin",
  ) {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await client.unsafe("SET ROLE kimiterrace_app");
      await client`SELECT set_config('app.current_school_id', ${schoolId}, false)`;
      await client`SELECT set_config('app.current_user_role', ${role}, false)`;
      return await fn(db);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校に学科を 1 件 (BYPASSRLS = 所有者接続)
    deptA = (
      await sql<{ id: string }[]>`
        INSERT INTO departments (school_id, name, display_order)
        VALUES (${fx.schoolA}, '工業科', 1) RETURNING id`
    )[0].id;
    deptB = (
      await sql<{ id: string }[]>`
        INSERT INTO departments (school_id, name, display_order)
        VALUES (${fx.schoolB}, '商業科', 1) RETURNING id`
    )[0].id;
    // 各校に学年を 1 件。A の学年は deptA に紐づく (削除ガード検証用)。
    gradeA = (
      await sql<{ id: string }[]>`
        INSERT INTO grades (school_id, department_id, name, display_order)
        VALUES (${fx.schoolA}, ${deptA}, '1年', 1) RETURNING id`
    )[0].id;
    gradeB = (
      await sql<{ id: string }[]>`
        INSERT INTO grades (school_id, name, display_order)
        VALUES (${fx.schoolB}, '1年', 1) RETURNING id`
    )[0].id;
    // A の学年にクラスを 1 件 (学年削除ガード検証用)。
    classA = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolA}, ${gradeA}, '1-A', 1) RETURNING id`
    )[0].id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("existsInSchool 相当: A context で自校 department は可視、他校 department は 0 件 (cross-tenant)", async () => {
    const own = await asSchool(fx.schoolA, (db) =>
      db.select({ id: departments.id }).from(departments).where(eq(departments.id, deptA)).limit(1),
    );
    expect(own).toHaveLength(1);
    // 他校 department を A context で引いても RLS で不可視 → Server Action は cross-tenant 拒否。
    const cross = await asSchool(fx.schoolA, (db) =>
      db.select({ id: departments.id }).from(departments).where(eq(departments.id, deptB)).limit(1),
    );
    expect(cross).toHaveLength(0);
  });

  it("existsInSchool 相当: A context で他校 grade は 0 件 (grade 付替先確認の越境拒否)", async () => {
    const cross = await asSchool(fx.schoolA, (db) =>
      db.select({ id: grades.id }).from(grades).where(eq(grades.id, gradeB)).limit(1),
    );
    expect(cross).toHaveLength(0);
  });

  it("countGradesInDepartment 相当: A context は自校学科の子学年のみ数える (他校 0)", async () => {
    // 自校: deptA に gradeA が紐づく → 1
    const own = await asSchool(fx.schoolA, (db) =>
      db.select({ n: count() }).from(grades).where(eq(grades.departmentId, deptA)),
    );
    expect(own[0].n).toBe(1);
    // A context で他校 deptB の子を数えても RLS で 0 (越境カウント不可)。
    const cross = await asSchool(fx.schoolA, (db) =>
      db.select({ n: count() }).from(grades).where(eq(grades.departmentId, deptB)),
    );
    expect(cross[0].n).toBe(0);
  });

  it("countClassesInGrade 相当: A context は自校学年の子クラスのみ数える", async () => {
    const own = await asSchool(fx.schoolA, (db) =>
      db.select({ n: count() }).from(classes).where(eq(classes.gradeId, gradeA)),
    );
    expect(own[0].n).toBe(1);
  });

  it("UPDATE 越境: A context で他校 grade を rename しても 0 行 (RLS で改変不可)", async () => {
    await asSchool(fx.schoolA, async (db) => {
      await db.update(grades).set({ name: "改竄" }).where(eq(grades.id, gradeB));
    });
    // 所有者接続で確認: B の学年名は変わっていない。
    const [row] = await sql<{ name: string }[]>`SELECT name FROM grades WHERE id = ${gradeB}`;
    expect(row.name).toBe("1年");
  });

  it("DELETE 越境: A context で他校 department を削除しても残る (RLS で削除不可)", async () => {
    await asSchool(fx.schoolA, async (db) => {
      await db.delete(departments).where(eq(departments.id, deptB));
    });
    const [row] = await sql<{ id: string }[]>`SELECT id FROM departments WHERE id = ${deptB}`;
    expect(row?.id).toBe(deptB);
  });

  it("DELETE 自校: A context で末端クラスは削除できる (子参照ガード不要)", async () => {
    await asSchool(fx.schoolA, async (db) => {
      await db.delete(classes).where(eq(classes.id, classA));
    });
    const rows = await sql<{ id: string }[]>`SELECT id FROM classes WHERE id = ${classA}`;
    expect(rows).toHaveLength(0);
  });
});
