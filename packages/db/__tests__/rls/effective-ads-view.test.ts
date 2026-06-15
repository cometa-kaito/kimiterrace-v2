import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEffectiveAdsForClass } from "../../src/queries/effective-ads.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-F: 広告階層マージ VIEW `effective_ads_per_class` を検証する。
 *
 * - 階層マージ: 1 クラスが「自クラス + 親学年 + 親学科 + 学校」の広告を継承する
 * - 別学年スコープ広告は混入しない (grade_id 一致のみ)
 * - grade_id NULL のクラスは学校スコープ広告のみ
 * - is_inherited フラグ (scope <> 'class') / scope_rank の正しさ
 * - **security_invoker による RLS**: 他テナントのクラス・広告は一切見えない
 * - クエリ層 getEffectiveAdsForClass の並び順
 */
describeOrSkip("VIEW: effective_ads_per_class (#48-F)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  // School A 階層
  let deptA: string;
  let gradeA1: string;
  let gradeA2: string;
  let classA1: string; // gradeA1 配下
  let classA2: string; // grade_id NULL
  // School B
  let classB1: string;
  // BUG-1: 広告主ステータス (休止=配信除外) 検証用
  let advActive: string;
  let advPaused: string;
  let advToggle: string;
  let classAdvStatic: string; // 稼働広告主 + 休止広告主の class 広告を載せる (grade_id NULL)
  let classAdvToggle: string; // 休止→稼働トグル検証用 (grade_id NULL)

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);

    // --- School A: 学科 → 学年 → クラス 階層 (owner 接続 = RLS バイパスで投入) ---
    deptA = (
      await sql<{ id: string }[]>`
        INSERT INTO departments (school_id, name, display_order)
        VALUES (${fx.schoolA}, '工業科', 1) RETURNING id
      `
    )[0].id;
    gradeA1 = (
      await sql<{ id: string }[]>`
        INSERT INTO grades (school_id, department_id, name, display_order)
        VALUES (${fx.schoolA}, ${deptA}, '1年', 1) RETURNING id
      `
    )[0].id;
    gradeA2 = (
      await sql<{ id: string }[]>`
        INSERT INTO grades (school_id, department_id, name, display_order)
        VALUES (${fx.schoolA}, ${deptA}, '2年', 2) RETURNING id
      `
    )[0].id;
    classA1 = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolA}, ${gradeA1}, '1-A', 1) RETURNING id
      `
    )[0].id;
    classA2 = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolA}, NULL, '0-X', 0) RETURNING id
      `
    )[0].id;

    // --- School B ---
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

    // --- School A の広告 4 階層 + 別学年広告 (混入しない検証用) ---
    await sql`INSERT INTO ads (school_id, scope, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'school', 'https://ex.com/a-school.png', 'image', 10)`;
    await sql`INSERT INTO ads (school_id, scope, department_id, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'department', ${deptA}, 'https://ex.com/a-dept.png', 'image', 20)`;
    await sql`INSERT INTO ads (school_id, scope, grade_id, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'grade', ${gradeA1}, 'https://ex.com/a-grade1.png', 'image', 30)`;
    // 別学年 (gradeA2) の広告 — classA1 には継承されないはず
    await sql`INSERT INTO ads (school_id, scope, grade_id, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'grade', ${gradeA2}, 'https://ex.com/a-grade2.png', 'image', 40)`;
    await sql`INSERT INTO ads (school_id, scope, class_id, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'class', ${classA1}, 'https://ex.com/a-class1.png', 'image', 50)`;

    // --- School B の広告 (テナント分離検証用) ---
    await sql`INSERT INTO ads (school_id, scope, media_url, media_type, display_order)
      VALUES (${fx.schoolB}, 'school', 'https://ex.com/b-school.png', 'image', 10)`;

    // --- BUG-1: 広告主ステータス (休止=配信除外) 検証用フィクスチャ (owner 接続で投入) ---
    advActive = (
      await sql<{ id: string }[]>`
        INSERT INTO advertisers (company_name, status, is_active)
        VALUES ('稼働広告主', 'active', true) RETURNING id
      `
    )[0].id;
    advPaused = (
      await sql<{ id: string }[]>`
        INSERT INTO advertisers (company_name, status, is_active)
        VALUES ('休止広告主', 'paused', false) RETURNING id
      `
    )[0].id;
    advToggle = (
      await sql<{ id: string }[]>`
        INSERT INTO advertisers (company_name, status, is_active)
        VALUES ('トグル広告主', 'paused', false) RETURNING id
      `
    )[0].id;
    // grade_id NULL のクラス = 学校スコープ広告のみ継承 → 広告主紐付き class 広告を隔離検証できる
    classAdvStatic = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolA}, NULL, '広告主静的', 0) RETURNING id
      `
    )[0].id;
    classAdvToggle = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolA}, NULL, '広告主トグル', 0) RETURNING id
      `
    )[0].id;
    // 稼働広告主の class 広告 (配信される) と 休止広告主の class 広告 (除外される)
    await sql`INSERT INTO ads (school_id, scope, class_id, advertiser_id, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'class', ${classAdvStatic}, ${advActive}, 'https://ex.com/adv-active.png', 'image', 60)`;
    await sql`INSERT INTO ads (school_id, scope, class_id, advertiser_id, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'class', ${classAdvStatic}, ${advPaused}, 'https://ex.com/adv-paused.png', 'image', 61)`;
    // トグル広告主の class 広告 (初期は休止 → 除外。テスト内で再開して復帰を確認)
    await sql`INSERT INTO ads (school_id, scope, class_id, advertiser_id, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'class', ${classAdvToggle}, ${advToggle}, 'https://ex.com/adv-toggle.png', 'image', 62)`;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("classA1 は 学校+学科+学年(自)+クラス の 4 広告を継承 (別学年は除外)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ source_scope: string; media_url: string }[]>`
        SELECT source_scope, media_url FROM effective_ads_per_class
        WHERE class_id = ${classA1}
        ORDER BY scope_rank, display_order, ad_id
      `;
      expect(rows.map((r) => r.source_scope)).toEqual(["school", "department", "grade", "class"]);
      // gradeA2 の広告 (a-grade2.png) は含まれない
      expect(rows.map((r) => r.media_url)).not.toContain("https://ex.com/a-grade2.png");
      expect(rows).toHaveLength(4);
    });
  });

  it("classA2 (grade_id NULL) は学校スコープ広告のみ継承", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ source_scope: string }[]>`
        SELECT source_scope FROM effective_ads_per_class WHERE class_id = ${classA2}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].source_scope).toBe("school");
    });
  });

  it("is_inherited: 親階層 (school/department/grade) は true、自クラスは false", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ source_scope: string; is_inherited: boolean }[]>`
        SELECT source_scope, is_inherited FROM effective_ads_per_class
        WHERE class_id = ${classA1}
      `;
      for (const r of rows) {
        expect(r.is_inherited).toBe(r.source_scope !== "class");
      }
    });
  });

  it("RLS: school A context では school B のクラスは VIEW に現れない (テナント分離)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      // classB1 を直接指定しても 0 件 (classes/ads とも RLS で A のみ可視)
      const rowsB = await tx<{ ad_id: string }[]>`
        SELECT ad_id FROM effective_ads_per_class WHERE class_id = ${classB1}
      `;
      expect(rowsB).toHaveLength(0);

      // VIEW 全体に現れる school_id は A のみ
      const schools = await tx<{ school_id: string }[]>`
        SELECT DISTINCT school_id FROM effective_ads_per_class
      `;
      expect(schools.map((s) => s.school_id)).toEqual([fx.schoolA]);
    });
  });

  it("RLS: school B context では classB1 が学校広告のみ継承、A は見えない", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ school_id: string; source_scope: string }[]>`
        SELECT school_id, source_scope FROM effective_ads_per_class WHERE class_id = ${classB1}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].school_id).toBe(fx.schoolB);
      expect(rows[0].source_scope).toBe("school");
    });
  });

  it("RLS: context 未設定なら VIEW は 0 件 (deny by default)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ ad_id: string }[]>`SELECT ad_id FROM effective_ads_per_class`;
      expect(rows).toHaveLength(0);
    });
  });

  it("system_admin: 単一クラス行内は自校広告のみ (school_id 結合で cross-tenant 防御)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      const rowsA = await tx<{ school_id: string }[]>`
        SELECT school_id FROM effective_ads_per_class WHERE class_id = ${classA1}
      `;
      // classA1 の実効広告はすべて school A の広告 (B の広告は混ざらない)
      expect(rowsA.length).toBe(4);
      expect(new Set(rowsA.map((r) => r.school_id))).toEqual(new Set([fx.schoolA]));
    });
  });

  it("クエリ層 getEffectiveAdsForClass: classA1 を階層順 (scope_rank→order→id) で返す", async () => {
    // session レベルでコンテキスト設定するため専用 max:1 接続を使う
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await client.unsafe("SET ROLE kimiterrace_app");
      await client`SELECT set_config('app.current_school_id', ${fx.schoolA}, false)`;
      await client`SELECT set_config('app.current_user_role', 'school_admin', false)`;

      const rows = await getEffectiveAdsForClass(db, classA1);

      expect(rows.map((r) => r.sourceScope)).toEqual(["school", "department", "grade", "class"]);
      expect(rows.map((r) => r.isInherited)).toEqual([true, true, true, false]);
      expect(rows.map((r) => r.scopeRank)).toEqual([0, 1, 2, 3]);
      expect(rows.map((r) => r.classId)).toEqual([classA1, classA1, classA1, classA1]);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("クエリ層: 他テナントのクラス ID を渡しても 0 件 (RLS)", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await client.unsafe("SET ROLE kimiterrace_app");
      await client`SELECT set_config('app.current_school_id', ${fx.schoolA}, false)`;
      await client`SELECT set_config('app.current_user_role', 'school_admin', false)`;

      const rows = await getEffectiveAdsForClass(db, classB1);
      expect(rows).toHaveLength(0);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("BUG-1: 休止広告主の広告は配信 VIEW から除外、稼働広告主・広告主なしは残る", async () => {
    await sql.begin(async (tx) => {
      // 配信と同じ非 system_admin (school_admin) コンテキスト = advertisers が不可視な文脈
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ media_url: string }[]>`
        SELECT media_url FROM effective_ads_per_class WHERE class_id = ${classAdvStatic}
      `;
      const urls = rows.map((r) => r.media_url);
      expect(urls).toContain("https://ex.com/adv-active.png"); // 稼働広告主 → 残る
      expect(urls).toContain("https://ex.com/a-school.png"); // 広告主なし(学校広告) → 残る
      expect(urls).not.toContain("https://ex.com/adv-paused.png"); // 休止広告主 → 除外
    });
  });

  it("BUG-1: 広告主を再開すると当該広告が配信 VIEW に復帰する (停止/再開の往復)", async () => {
    const toggleAdVisible = async (): Promise<boolean> => {
      let found = false;
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        const rows = await tx<{ media_url: string }[]>`
          SELECT media_url FROM effective_ads_per_class WHERE class_id = ${classAdvToggle}
        `;
        found = rows.some((r) => r.media_url === "https://ex.com/adv-toggle.png");
      });
      return found;
    };

    // 初期 = 休止 → 除外
    expect(await toggleAdVisible()).toBe(false);
    // 再開 (status:active / is_active:true を同時 set、不変条件 PR #534) → 復帰
    await sql`UPDATE advertisers SET status = 'active', is_active = true WHERE id = ${advToggle}`;
    expect(await toggleAdVisible()).toBe(true);
    // 再度休止 → また除外 (冪等)
    await sql`UPDATE advertisers SET status = 'paused', is_active = false WHERE id = ${advToggle}`;
    expect(await toggleAdVisible()).toBe(false);
  });
});
