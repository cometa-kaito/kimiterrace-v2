import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDailyWindowRows } from "../../src/queries/daily-window.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-K3: 学校管理ハブ「本日の掲示状態」用 `getDailyWindowRows` の実 PG + RLS 検証。
 *
 * 本関数はサイネージ実表示と同じ遡及窓 (今日を含む過去 EFFECTIVE_LOOKBACK_DAYS 日) の daily_data を
 * 自校・全 scope まとめて返す層。検証する DB レベルの契約は 2 つ:
 *  1. **日付境界 (JST)**: 窓内 (今日 / 昨日 / 30 日前) は返し、窓外 (40 日前) と未来 (明日) は返さない。
 *     各行の `today` は JST の今日。境界は SQL 側 `(now() AT TIME ZONE 'Asia/Tokyo')::date` で決まる。
 *  2. **テナント分離 (ルール2)**: 自校コンテキストでは自校行のみ。他校 (B) の行は混ざらない。
 *     context 未設定は deny-by-default で 0 件。
 *
 * 活性判定 (連絡の表示日数 / 提出物の期限+猶予で「今日も掲示中か」) は apps/web の純関数
 * (`reduceTodayActiveScopes` / `isWindowRowActiveToday`、サイネージと同 helper) が担い、その単体は
 * apps/web の hub-queries.test.ts が固める。ここは **窓の DB 読み取り (範囲 + RLS)** に集中する。
 *
 * 窓に使う lookback は本番 (apps/web EFFECTIVE_LOOKBACK_DAYS) と同じ 31。packages からは apps/web の
 * 定数を import できないため値で固定し、ズレたら本テストが検知する。
 */
const LOOKBACK_DAYS = 31;

describeOrSkip("RLS: getDailyWindowRows (本日の掲示状態の遡及窓 read, #48-K3)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;
  let classB: string;
  // JST 基準の日付文字列 (DB から取得し、seed と query の窓基準を一致させる)。
  let today: string;
  let yesterday: string;
  let thirtyAgo: string;
  let fortyAgo: string;
  let tomorrow: string;

  /**
   * 自校 RLS コンテキスト (school_admin) を張った max:1 接続で fn を実行する。
   * `withSession`(school_admin) 相当 — school_id + role を set する。schoolId=null は deny-by-default。
   */
  async function asSchool<T>(
    schoolId: string | null,
    fn: (db: ReturnType<typeof drizzle>) => Promise<T>,
  ) {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await client.unsafe("SET ROLE kimiterrace_app");
      if (schoolId) {
        await client`SELECT set_config('app.current_school_id', ${schoolId}, false)`;
        await client`SELECT set_config('app.current_user_role', 'school_admin', false)`;
      }
      return await fn(db);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);

    // JST 基準日 (今日/昨日/30 日前/40 日前/明日) を DB の同じ式で確定する。
    [{ today, yesterday, thirtyAgo, fortyAgo, tomorrow }] = await sql<
      {
        today: string;
        yesterday: string;
        thirtyAgo: string;
        fortyAgo: string;
        tomorrow: string;
      }[]
    >`
      SELECT
        (now() AT TIME ZONE 'Asia/Tokyo')::date::text                AS "today",
        ((now() AT TIME ZONE 'Asia/Tokyo')::date - 1)::text          AS "yesterday",
        ((now() AT TIME ZONE 'Asia/Tokyo')::date - 30)::text         AS "thirtyAgo",
        ((now() AT TIME ZONE 'Asia/Tokyo')::date - 40)::text         AS "fortyAgo",
        ((now() AT TIME ZONE 'Asia/Tokyo')::date + 1)::text          AS "tomorrow"
    `;

    // クラスを各校 1 件 (BYPASSRLS = テーブル所有者接続で投入)。
    classA = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, academic_year, name, grade)
        VALUES (${fx.schoolA}, 2026, '1-A', 1) RETURNING id
      `
    )[0].id;
    classB = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, academic_year, name, grade)
        VALUES (${fx.schoolB}, 2026, '1-B', 1) RETURNING id
      `
    )[0].id;

    const notice = sql.json([{ text: "三者面談のお知らせ", displayDays: 3 }]);
    const assignment = sql.json([{ deadline: today, subject: "数学", task: "p10" }]);
    const schedule = sql.json([{ period: 1, subject: "数学" }]);
    const empty = sql.json([]);

    // school A: 窓内 (today / yesterday / 30日前) + school scope today、窓外 (40日前) と未来 (明日)。
    await sql`INSERT INTO daily_data (school_id, scope, class_id, date, schedules)
      VALUES (${fx.schoolA}, 'class', ${classA}, ${today}, ${schedule})`;
    await sql`INSERT INTO daily_data (school_id, scope, class_id, date, notices)
      VALUES (${fx.schoolA}, 'class', ${classA}, ${yesterday}, ${notice})`;
    await sql`INSERT INTO daily_data (school_id, scope, class_id, date, assignments)
      VALUES (${fx.schoolA}, 'class', ${classA}, ${thirtyAgo}, ${assignment})`;
    await sql`INSERT INTO daily_data (school_id, scope, class_id, date, notices)
      VALUES (${fx.schoolA}, 'class', ${classA}, ${fortyAgo}, ${notice})`; // 窓外
    await sql`INSERT INTO daily_data (school_id, scope, date, notices)
      VALUES (${fx.schoolA}, 'school', ${today}, ${notice})`;
    await sql`INSERT INTO daily_data (school_id, scope, date, schedules)
      VALUES (${fx.schoolA}, 'school', ${tomorrow}, ${schedule})`; // 未来

    // school B: today のクラス行 (RLS 分離の対照)。
    await sql`INSERT INTO daily_data (school_id, scope, class_id, date, notices)
      VALUES (${fx.schoolB}, 'class', ${classB}, ${today}, ${notice})`;
    // 空セクションだけの行も投入 (窓には入るが活性判定は apps/web 側、ここは行が返ること自体を見る)。
    await sql`INSERT INTO daily_data (school_id, scope, date, schedules)
      VALUES (${fx.schoolA}, 'school', ${yesterday}, ${empty})`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("自校 (A): 窓内の行のみ返す (40日前=窓外 / 明日=未来 は除外)", async () => {
    const rows = await asSchool(fx.schoolA, (db) => getDailyWindowRows(db as never, LOOKBACK_DAYS));
    const dates = rows.map((r) => r.date).sort();
    // 窓内: today(class), yesterday(class), 30日前(class), today(school), yesterday(school, 空) = 5 行。
    expect(rows).toHaveLength(5);
    expect(dates).toEqual([thirtyAgo, yesterday, yesterday, today, today].sort());
    // 窓外 / 未来は混ざらない。
    expect(rows.some((r) => r.date === fortyAgo)).toBe(false);
    expect(rows.some((r) => r.date === tomorrow)).toBe(false);
  });

  it("各行の today は JST の今日 (境界判定の基準が SQL 側 JST で一貫)", async () => {
    const rows = await asSchool(fx.schoolA, (db) => getDailyWindowRows(db as never, LOOKBACK_DAYS));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.today === today)).toBe(true);
  });

  it("scope と jsonb セクションがそのまま読める (連絡/提出物/予定の中身が届く)", async () => {
    const rows = await asSchool(fx.schoolA, (db) => getDailyWindowRows(db as never, LOOKBACK_DAYS));
    // 昨日の class scope 連絡 = 複数日連絡 (displayDays:3) が中身ごと届く。
    const noticeRow = rows.find((r) => r.scope === "class" && r.date === yesterday);
    expect(noticeRow?.notices).toEqual([{ text: "三者面談のお知らせ", displayDays: 3 }]);
    // 30 日前の提出物 (期限=today) が中身ごと届く。
    const assignRow = rows.find((r) => r.scope === "class" && r.date === thirtyAgo);
    expect(assignRow?.assignments).toEqual([{ deadline: today, subject: "数学", task: "p10" }]);
  });

  it("RLS: 自校 (A) コンテキストでは他校 (B) の行が混ざらない (テナント分離)", async () => {
    const rows = await asSchool(fx.schoolA, (db) => getDailyWindowRows(db as never, LOOKBACK_DAYS));
    expect(rows.some((r) => r.classId === classB)).toBe(false);
    expect(rows.every((r) => r.scope === "school" || r.classId === classA)).toBe(true);
  });

  it("RLS: 他校 (B) コンテキストでは B の行のみ (A は不可視)", async () => {
    const rows = await asSchool(fx.schoolB, (db) => getDailyWindowRows(db as never, LOOKBACK_DAYS));
    expect(rows).toHaveLength(1);
    expect(rows[0].classId).toBe(classB);
    expect(rows.some((r) => r.classId === classA)).toBe(false);
  });

  it("RLS: context 未設定は deny-by-default で 0 件", async () => {
    const rows = await asSchool(null, (db) => getDailyWindowRows(db as never, LOOKBACK_DAYS));
    expect(rows).toHaveLength(0);
  });
});
