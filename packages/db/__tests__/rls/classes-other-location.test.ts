import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { classes } from "../../src/schema/classes.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * 「その他」(非教室の設置場所 = `grade_id IS NULL` のクラス) のスキーマ不変条件を実 PG で検証する
 * (migration `drizzle/<tag>_signage_other_locations.sql`)。
 *
 * 検証:
 *   1. 学科配下の「その他」名は (school_id, department_id, name) WHERE grade_id IS NULL で一意
 *      (`ux_classes_school_dept_other_name`)。同一学科の同名設置場所 2 件目を拒否。
 *   2. 別学科なら同名でも衝突しない (department_id 次元)。
 *   3. 学校直下 (department_id NULL) は Postgres が NULL を distinct 扱いするため DB では一意化されない
 *      (= create action の自校重複チェックが補完する責務であることを固定)。
 *   4. department の削除で「その他」クラスの department_id は set null になり、クラス自体は残る
 *      (FK onDelete: set null・学校直下の「その他」へ降格)。
 *   5. テナント分離: 自校の「その他」クラスは自校 context でのみ可視・他校 context では不可視。
 *
 * index/FK は role 非依存ゆえ owner 接続(BYPASSRLS)の直接 INSERT で検証し、テナント分離は
 * `kimiterrace_app` 降格 (withTenantContext) で RLS を実際に効かせる。実 PG が要るため DATABASE_URL
 * 未設定ではスキップ (ADR-012)。UUID は他テストと衝突しない `07he-`/`0de7-` 系を使う。
 */
describeOrSkip("classes「その他」(grade_id NULL) の制約とテナント分離", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;

  const DEPT_A = "0de70a00-0000-4000-8000-0000000000a1";
  const DEPT_A2 = "0de70a00-0000-4000-8000-0000000000a2";
  const DEPT_B = "0de70b00-0000-4000-8000-0000000000b1";
  const OTHER_A = "07e4a000-0000-4000-8000-0000000000a1";

  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    await sql`RESET ROLE`;
    await sql`
      INSERT INTO departments (id, school_id, name, display_order) VALUES
        (${DEPT_A}, ${fx.schoolA}, '電子工学科', 1),
        (${DEPT_A2}, ${fx.schoolA}, '機械工学科', 2),
        (${DEPT_B}, ${fx.schoolB}, '普通科', 1)
    `;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  /** 「その他」(grade_id NULL・grade NULL) のクラスを 1 件 INSERT する。 */
  async function insertOther(
    schoolId: string,
    departmentId: string | null,
    name: string,
    id?: string,
  ): Promise<void> {
    await sql`
      INSERT INTO classes (id, school_id, grade_id, department_id, name, grade)
      VALUES (${id ?? sql`gen_random_uuid()`}, ${schoolId}, NULL, ${departmentId}, ${name}, NULL)
    `;
  }

  it("学科配下の同名「その他」2 件目は 23505 で拒否 (ux_classes_school_dept_other_name)", async () => {
    await insertOther(fx.schoolA, DEPT_A, "玄関");
    await expect(insertOther(fx.schoolA, DEPT_A, "玄関")).rejects.toThrow(
      /ux_classes_school_dept_other_name|duplicate key|unique/i,
    );
  });

  it("別学科なら同名「その他」でも衝突しない (department_id 次元)", async () => {
    await insertOther(fx.schoolA, DEPT_A, "玄関");
    await insertOther(fx.schoolA, DEPT_A2, "玄関");
    const rows = await sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM classes WHERE grade_id IS NULL AND name = '玄関'
    `;
    expect(Number(rows[0].c)).toBe(2);
  });

  it("学校直下 (department_id NULL) の同名「その他」は DB では一意化されない (app チェックが補完)", async () => {
    await insertOther(fx.schoolA, null, "廊下");
    await insertOther(fx.schoolA, null, "廊下");
    const rows = await sql<{ c: string }[]>`
      SELECT count(*)::text AS c
      FROM classes WHERE grade_id IS NULL AND department_id IS NULL AND name = '廊下'
    `;
    expect(Number(rows[0].c)).toBe(2);
  });

  it("学科削除で「その他」の department_id は set null・クラスは残る (学校直下へ降格)", async () => {
    await insertOther(fx.schoolA, DEPT_A, "職員室前", OTHER_A);
    await sql`DELETE FROM departments WHERE id = ${DEPT_A}`;
    const rows = await sql<{ department_id: string | null }[]>`
      SELECT department_id FROM classes WHERE id = ${OTHER_A}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].department_id).toBeNull();
  });

  it("テナント分離: 自校の「その他」は自校 context でのみ可視・他校は不可視", async () => {
    await insertOther(fx.schoolA, DEPT_A, "正門", OTHER_A);

    const own = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) => tx.select({ id: classes.id }).from(classes).where(eq(classes.id, OTHER_A)),
      APP,
    );
    expect(own.map((r) => r.id)).toContain(OTHER_A);

    const cross = await withTenantContext(
      db,
      { schoolId: fx.schoolB, role: "school_admin", userId: fx.userB },
      (tx) => tx.select({ id: classes.id }).from(classes).where(eq(classes.id, OTHER_A)),
      APP,
    );
    expect(cross.length).toBe(0);
  });

  it("サニティ: 「その他」は grade_id/grade ともに NULL で保持される", async () => {
    await insertOther(fx.schoolA, DEPT_A, "体育館前", OTHER_A);
    const rows = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) =>
        tx
          .select({ id: classes.id, gradeId: classes.gradeId, grade: classes.grade })
          .from(classes)
          .where(isNull(classes.gradeId)),
      APP,
    );
    const row = rows.find((r) => r.id === OTHER_A);
    expect(row?.gradeId).toBeNull();
    expect(row?.grade).toBeNull();
  });
});
