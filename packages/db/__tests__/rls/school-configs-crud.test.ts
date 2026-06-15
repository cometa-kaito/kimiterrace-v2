import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClassConfigValue, upsertClassConfig } from "../../src/queries/school-configs.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-J-2: 学校設定 (school_configs) の quiet_hours upsert / 読み取りクエリ層を実 PG + RLS で検証する。
 *
 * - upsertClassConfig: scope='class' + class_id + kind='quiet_hours' の 1 行を upsert
 *   (`ux_school_configs_target` NULLS NOT DISTINCT で再保存は UPDATE になる)。
 * - getClassConfigValue: 自クラス設定の value を返す。
 * - **RLS テナント分離 (ルール2)**: 他校コンテキストでは自校の設定が不可視 (kimiterrace_app + context)。
 *   他校の class_id への書き込みは RLS WITH CHECK / FK 越境で防がれる。
 */
describeOrSkip("queries: school_configs quiet_hours CRUD クエリ層 (#48-J-2)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA1: string;
  let classB1: string;

  /** RLS context を張った max:1 接続で fn を実行する (session レベル set_config)。 */
  async function asSchool<T>(
    schoolId: string,
    userId: string,
    fn: (db: ReturnType<typeof drizzle>) => Promise<T>,
  ) {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await client.unsafe("SET ROLE kimiterrace_app");
      await client`SELECT set_config('app.current_school_id', ${schoolId}, false)`;
      await client`SELECT set_config('app.current_user_role', 'school_admin', false)`;
      await client`SELECT set_config('app.current_user_id', ${userId}, false)`;
      return await fn(db);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);

    const gradeA1 = (
      await sql<{ id: string }[]>`
        INSERT INTO grades (school_id, name, display_order)
        VALUES (${fx.schoolA}, '1年', 1) RETURNING id
      `
    )[0].id;
    classA1 = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolA}, ${gradeA1}, '1-A', 1) RETURNING id
      `
    )[0].id;
    const gradeB1 = (
      await sql<{ id: string }[]>`
        INSERT INTO grades (school_id, name, display_order)
        VALUES (${fx.schoolB}, '1年', 1) RETURNING id
      `
    )[0].id;
    classB1 = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolB}, ${gradeB1}, '1-B', 1) RETURNING id
      `
    )[0].id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("upsert (insert) → getClassConfigValue で自校が読める", async () => {
    const value = { ranges: [{ start: "12:00", end: "13:00" }] };
    const id = await asSchool(fx.schoolA, fx.userA, (db) =>
      upsertClassConfig(db as never, {
        schoolId: fx.schoolA,
        classId: classA1,
        kind: "quiet_hours",
        value,
        actorUserId: fx.userA,
      }),
    );
    expect(id).toBeTruthy();
    const read = await asSchool(fx.schoolA, fx.userA, (db) =>
      getClassConfigValue(db as never, classA1, "quiet_hours"),
    );
    expect(read).toEqual(value);
  });

  it("再 upsert は UPDATE になり 1 行のまま (NULLS NOT DISTINCT 一意制約)", async () => {
    const first = await asSchool(fx.schoolA, fx.userA, (db) =>
      upsertClassConfig(db as never, {
        schoolId: fx.schoolA,
        classId: classA1,
        kind: "quiet_hours",
        value: { ranges: [{ start: "09:00", end: "10:00" }] },
        actorUserId: fx.userA,
      }),
    );
    const second = await asSchool(fx.schoolA, fx.userA, (db) =>
      upsertClassConfig(db as never, {
        schoolId: fx.schoolA,
        classId: classA1,
        kind: "quiet_hours",
        value: { ranges: [{ start: "15:00", end: "16:00" }] },
        actorUserId: fx.userA,
      }),
    );
    // 同一行が更新される (id 不変)。
    expect(second).toBe(first);
    const read = await asSchool(fx.schoolA, fx.userA, (db) =>
      getClassConfigValue(db as never, classA1, "quiet_hours"),
    );
    expect(read).toEqual({ ranges: [{ start: "15:00", end: "16:00" }] });
    // DB 上も class+kind は 1 行のみ (BYPASSRLS 接続で確認)。
    const count = (
      await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM school_configs
        WHERE class_id = ${classA1} AND kind = 'quiet_hours'
      `
    )[0].n;
    expect(count).toBe(1);
  });

  it("RLS: school B context では school A の設定が不可視 (テナント分離)", async () => {
    const read = await asSchool(fx.schoolB, fx.userB, (db) =>
      getClassConfigValue(db as never, classA1, "quiet_hours"),
    );
    expect(read).toBeNull();
  });

  it("RLS: school B は自クラスに独立して設定でき、A からは見えない", async () => {
    await asSchool(fx.schoolB, fx.userB, (db) =>
      upsertClassConfig(db as never, {
        schoolId: fx.schoolB,
        classId: classB1,
        kind: "quiet_hours",
        value: { ranges: [{ start: "20:00", end: "21:00" }] },
        actorUserId: fx.userB,
      }),
    );
    const readB = await asSchool(fx.schoolB, fx.userB, (db) =>
      getClassConfigValue(db as never, classB1, "quiet_hours"),
    );
    expect(readB).toEqual({ ranges: [{ start: "20:00", end: "21:00" }] });
    const crossA = await asSchool(fx.schoolA, fx.userA, (db) =>
      getClassConfigValue(db as never, classB1, "quiet_hours"),
    );
    expect(crossA).toBeNull();
  });

  it("RLS: 他校 school_id を詐称した upsert は WITH CHECK 違反で失敗", async () => {
    // school A context で school B の school_id / class_id を渡しても RLS が弾く。
    await expect(
      asSchool(fx.schoolA, fx.userA, (db) =>
        upsertClassConfig(db as never, {
          schoolId: fx.schoolB,
          classId: classB1,
          kind: "quiet_hours",
          value: { ranges: [{ start: "01:00", end: "02:00" }] },
          actorUserId: fx.userA,
        }),
      ),
    ).rejects.toThrow();
  });
});
