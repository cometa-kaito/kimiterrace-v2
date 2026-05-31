import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findClassOwnAd, findVisibleClass, listClassOwnAds } from "../../src/queries/ads.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-J: クラススコープ広告のクエリ層 (listClassOwnAds / findVisibleClass / findClassOwnAd) を
 * 実 PG + RLS で検証する。
 *
 * - listClassOwnAds: 自クラススコープ広告 (scope='class' AND class_id=該当) のみ表示順で返す。
 *   親階層 (学校/学年) の継承広告は含まない。
 * - **RLS テナント分離 (ルール2)**: 他校のクラス id を渡しても 0 件 / null (kimiterrace_app + context)。
 * - findVisibleClass: 自校クラスは取得、他校クラスは null。
 * - findClassOwnAd: 自クラス広告は取得、継承広告 (scope≠class) は null (編集対象外)。
 */
describeOrSkip("queries: ads CRUD クエリ層 (#48-J)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA1: string;
  let classB1: string;
  let ownAd1: string;
  let ownAd2: string;

  /** RLS context を張った max:1 接続で fn を実行する (session レベル set_config)。 */
  async function asSchool<T>(schoolId: string, fn: (db: ReturnType<typeof drizzle>) => Promise<T>) {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await client.unsafe("SET ROLE kimiterrace_app");
      await client`SELECT set_config('app.current_school_id', ${schoolId}, false)`;
      await client`SELECT set_config('app.current_user_role', 'school_admin', false)`;
      return await fn(db);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);

    // School A: 学年 → クラス、自クラス広告 2 件 + 学校スコープ広告 1 件 (継承、ownAds に出ない)
    const gradeA1 = (
      await sql<{ id: string }[]>`
        INSERT INTO grades (school_id, name, display_order)
        VALUES (${fx.schoolA}, '1年', 1) RETURNING id
      `
    )[0].id;
    classA1 = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, academic_year, name, grade)
        VALUES (${fx.schoolA}, ${gradeA1}, 2026, '1-A', 1) RETURNING id
      `
    )[0].id;
    ownAd2 = (
      await sql<{ id: string }[]>`
        INSERT INTO ads (school_id, scope, class_id, media_url, media_type, display_order)
        VALUES (${fx.schoolA}, 'class', ${classA1}, 'https://ex.com/a-class-2.png', 'image', 20)
        RETURNING id
      `
    )[0].id;
    ownAd1 = (
      await sql<{ id: string }[]>`
        INSERT INTO ads (school_id, scope, class_id, media_url, media_type, display_order)
        VALUES (${fx.schoolA}, 'class', ${classA1}, 'https://ex.com/a-class-1.png', 'image', 10)
        RETURNING id
      `
    )[0].id;
    // 学校スコープ広告 (継承、自クラス一覧に出ないことの検証用)
    await sql`INSERT INTO ads (school_id, scope, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'school', 'https://ex.com/a-school.png', 'image', 5)`;

    // School B のクラス + 広告 (テナント分離検証用)
    const gradeB1 = (
      await sql<{ id: string }[]>`
        INSERT INTO grades (school_id, name, display_order)
        VALUES (${fx.schoolB}, '1年', 1) RETURNING id
      `
    )[0].id;
    classB1 = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, academic_year, name, grade)
        VALUES (${fx.schoolB}, ${gradeB1}, 2026, '1-B', 1) RETURNING id
      `
    )[0].id;
    await sql`INSERT INTO ads (school_id, scope, class_id, media_url, media_type, display_order)
      VALUES (${fx.schoolB}, 'class', ${classB1}, 'https://ex.com/b-class.png', 'image', 10)`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("listClassOwnAds: 自クラススコープ広告のみ display_order 昇順 (学校継承は含まない)", async () => {
    const rows = await asSchool(fx.schoolA, (db) => listClassOwnAds(db as never, classA1));
    expect(rows.map((r) => r.id)).toEqual([ownAd1, ownAd2]); // order 10 → 20
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.mediaUrl)).not.toContain("https://ex.com/a-school.png");
  });

  it("RLS: school A context で school B のクラス広告は 0 件 (テナント分離)", async () => {
    const rows = await asSchool(fx.schoolA, (db) => listClassOwnAds(db as never, classB1));
    expect(rows).toHaveLength(0);
  });

  it("RLS: school B context では自クラス広告のみ、A は見えない", async () => {
    const rowsB = await asSchool(fx.schoolB, (db) => listClassOwnAds(db as never, classB1));
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].mediaUrl).toBe("https://ex.com/b-class.png");
    const rowsA = await asSchool(fx.schoolB, (db) => listClassOwnAds(db as never, classA1));
    expect(rowsA).toHaveLength(0);
  });

  it("findVisibleClass: 自校クラスは取得、他校クラスは null (cross-tenant)", async () => {
    const ok = await asSchool(fx.schoolA, (db) => findVisibleClass(db as never, classA1));
    expect(ok?.name).toBe("1-A");
    const cross = await asSchool(fx.schoolA, (db) => findVisibleClass(db as never, classB1));
    expect(cross).toBeNull();
  });

  it("findClassOwnAd: 自クラス広告は取得、他校広告は null", async () => {
    const ok = await asSchool(fx.schoolA, (db) => findClassOwnAd(db as never, ownAd1));
    expect(ok?.classId).toBe(classA1);
    expect(ok?.scope).toBe("class");
    // school B の自クラス広告 id を A context で引いても不可視 (RLS)
    const bAdId = (await asSchool(fx.schoolB, (db) => listClassOwnAds(db as never, classB1)))[0].id;
    const cross = await asSchool(fx.schoolA, (db) => findClassOwnAd(db as never, bAdId));
    expect(cross).toBeNull();
  });

  it("findClassOwnAd: 継承広告 (scope='school') は対象外 → null", async () => {
    const schoolAdId = (
      await sql<{ id: string }[]>`
        SELECT id FROM ads WHERE school_id = ${fx.schoolA} AND scope = 'school' LIMIT 1
      `
    )[0].id;
    const row = await asSchool(fx.schoolA, (db) => findClassOwnAd(db as never, schoolAdId));
    expect(row).toBeNull();
  });
});
