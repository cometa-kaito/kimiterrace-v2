import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  deleteStaleCalendarEvents,
  getCalendarEvents,
  listEnabledCalendarSources,
  upsertCalendarEvent,
  upsertCalendarSource,
} from "../../src/queries/school-calendar.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * ADR-045: 学校行事カレンダーの per-school テーブル school_calendar_sources / school_calendar_events の RLS
 * （tenant_isolation）を実 PG で検証する。tv_device_downtime / daily_data の tenant RLS テストを手本にする。
 *
 * 検証の核（Reviewer 重点 = テナント分離 + PII 露出面）:
 *   - tenant_isolation: 自校 SELECT 可・他校不可（他校行は 0 件で不可視）。
 *   - **匿名サイネージ**（role 未設定・school_id のみ set）が **自校イベント**を読める / **他校は読めない**（ADR-016）。
 *   - 非該当 school_id への書込みは WITH CHECK で拒否。
 *   - system_admin（取得 Job 経路）は cross-tenant に列挙・upsert 可。`(school_id, uid)` upsert は冪等。
 *   - deleteStaleCalendarEvents: keepUids に無い行を掃除 / keepUids 空は no-op（last-known-good 維持）。
 *
 * 接続ロールは superuser だが、トランザクション内で `SET LOCAL ROLE kimiterrace_app` に降格して RLS を実際に
 * 効かせる（さもないと所有者バイパスで vacuous になる）。実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ
 * （ADR-012）。
 */
describeOrSkip("RLS: ADR-045 school_calendar (tenant_isolation)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    // calendar テーブルは seedBaseFixture の TRUNCATE 対象外（後発テーブル）なので明示クリア。
    await sql.unsafe(
      "TRUNCATE school_calendar_events, school_calendar_sources RESTART IDENTITY CASCADE;",
    );
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  // owner（BYPASSRLS）でソース行をシードするヘルパ。
  async function seedSource(schoolId: string, icsUrl: string, enabled = true): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO school_calendar_sources (school_id, ics_url, enabled)
      VALUES (${schoolId}, ${icsUrl}, ${enabled})
      RETURNING id
    `;
    return row.id;
  }

  // owner（BYPASSRLS）でイベント行をシードするヘルパ。
  async function seedEvent(
    schoolId: string,
    uid: string,
    startDate: string,
    summary = "行事",
  ): Promise<void> {
    await sql`
      INSERT INTO school_calendar_events (school_id, uid, start_date, summary)
      VALUES (${schoolId}, ${uid}, ${startDate}, ${summary})
    `;
  }

  // ---- tenant_isolation: sources ----

  it("sources: school A context は A のソースのみ可視（他校不可視）", async () => {
    await seedSource(fx.schoolA, "https://a.test/cal.ics");
    await seedSource(fx.schoolB, "https://b.test/cal.ics");
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      return tx<{ school_id: string }[]>`SELECT school_id FROM school_calendar_sources`;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].school_id).toBe(fx.schoolA);
  });

  it("sources: 他校 school_id への INSERT は WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO school_calendar_sources (school_id, ics_url)
          VALUES (${fx.schoolB}, 'https://evil.test/cal.ics')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  // ---- tenant_isolation: events ----

  it("events: school A context は A の行事のみ可視（他校不可視）", async () => {
    await seedEvent(fx.schoolA, "uid-a", "2026-04-08");
    await seedEvent(fx.schoolB, "uid-b", "2026-04-08");
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      return tx<
        { uid: string; school_id: string }[]
      >`SELECT uid, school_id FROM school_calendar_events`;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].uid).toBe("uid-a");
    expect(rows[0].school_id).toBe(fx.schoolA);
  });

  it("★ events: 匿名サイネージ（role 未設定・school_id のみ set）は自校の行事のみ読める（ADR-016）", async () => {
    await seedEvent(fx.schoolA, "uid-a", "2026-04-08");
    await seedEvent(fx.schoolB, "uid-b", "2026-04-08");
    // 自校（A）: role を set せず school_id のみ set → tenant_isolation USING で自校だけ読める。
    const aRows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      return tx<{ uid: string }[]>`SELECT uid FROM school_calendar_events`;
    });
    expect(aRows.map((r) => r.uid)).toEqual(["uid-a"]);

    // 他校（B の school_id）を set すると A の行事は見えず B のみ（越境不可）。
    const bRows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      return tx<{ uid: string }[]>`SELECT uid FROM school_calendar_events`;
    });
    expect(bRows.map((r) => r.uid)).toEqual(["uid-b"]);
  });

  it("★ events: context 未設定（school_id も role も無し）は全件拒否（deny-by-default）", async () => {
    await seedEvent(fx.schoolA, "uid-a", "2026-04-08");
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      return tx<{ id: string }[]>`SELECT id FROM school_calendar_events`;
    });
    expect(rows.length).toBe(0);
  });

  it("events: 他校 school_id への INSERT は WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO school_calendar_events (school_id, uid, start_date)
          VALUES (${fx.schoolB}, 'evil', '2026-04-08')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("system_admin は cross-tenant で全校のソース / 行事が見える", async () => {
    await seedSource(fx.schoolA, "https://a.test/cal.ics");
    await seedSource(fx.schoolB, "https://b.test/cal.ics");
    await seedEvent(fx.schoolA, "uid-a", "2026-04-08");
    await seedEvent(fx.schoolB, "uid-b", "2026-04-08");
    const { sources, events } = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const s = await tx<{ id: string }[]>`SELECT id FROM school_calendar_sources`;
      const e = await tx<{ id: string }[]>`SELECT id FROM school_calendar_events`;
      return { sources: s, events: e };
    });
    expect(sources.length).toBe(2);
    expect(events.length).toBe(2);
  });

  // ---- 取得 Job 経路（system context）: 列挙 + upsert（冪等） + 掃除 ----

  it("listEnabledCalendarSources: system context で enabled のみ列挙（cross-tenant）", async () => {
    await seedSource(fx.schoolA, "https://a.test/cal.ics", true);
    await seedSource(fx.schoolB, "https://b.test/cal.ics", false); // disabled は除外
    const list = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => listEnabledCalendarSources(tx),
      APP,
    );
    expect(list.length).toBe(1);
    expect(list[0].schoolId).toBe(fx.schoolA);
    expect(list[0].icsUrl).toBe("https://a.test/cal.ics");
  });

  it("upsertCalendarEvent: system context で INSERT、(school_id, uid) 競合で UPDATE（冪等）", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const d = drizzle(client);
      const id1 = await withTenantContext(
        d,
        { role: "system_admin" },
        (tx) =>
          upsertCalendarEvent(tx, {
            schoolId: fx.schoolA,
            uid: "evt-1",
            summary: "始業式",
            startDate: "2026-04-08",
            allDay: true,
            raw: { v: 1 },
          }),
        APP,
      );
      const id2 = await withTenantContext(
        d,
        { role: "system_admin" },
        (tx) =>
          upsertCalendarEvent(tx, {
            schoolId: fx.schoolA,
            uid: "evt-1",
            summary: "始業式（変更）",
            startDate: "2026-04-09",
            allDay: true,
            raw: { v: 2 },
          }),
        APP,
      );
      expect(id2).toBe(id1); // upsert で行は増えない

      await client.unsafe("RESET ROLE");
      const rows = await client<
        { summary: string; start_date: string; created_by: string | null }[]
      >`SELECT summary, start_date::text AS start_date, created_by FROM school_calendar_events WHERE school_id = ${fx.schoolA}`;
      expect(rows.length).toBe(1);
      expect(rows[0].summary).toBe("始業式（変更）");
      expect(rows[0].start_date).toBe("2026-04-09");
      expect(rows[0].created_by).toBeNull(); // システム書き込み（ルール1）
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("deleteStaleCalendarEvents: keepUids に無い行を掃除 / keepUids 空は no-op（last-known-good）", async () => {
    await seedEvent(fx.schoolA, "keep-1", "2026-04-08");
    await seedEvent(fx.schoolA, "stale-1", "2026-04-09");
    await seedEvent(fx.schoolB, "other-1", "2026-04-10");

    // keepUids=["keep-1"] → stale-1 のみ削除（自校）。他校 other-1 は触らない（system でも school_id 明示で絞る）。
    const deleted = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => deleteStaleCalendarEvents(tx, fx.schoolA, ["keep-1"]),
      APP,
    );
    expect(deleted).toBe(1);

    await sql`RESET ROLE`;
    const aRows = await sql<{ uid: string }[]>`
      SELECT uid FROM school_calendar_events WHERE school_id = ${fx.schoolA} ORDER BY uid
    `;
    expect(aRows.map((r) => r.uid)).toEqual(["keep-1"]);
    const bRows = await sql<{ uid: string }[]>`
      SELECT uid FROM school_calendar_events WHERE school_id = ${fx.schoolB}
    `;
    expect(bRows.map((r) => r.uid)).toEqual(["other-1"]); // 他校は無傷

    // keepUids 空は no-op（取得 0 件で全消ししない）。
    const deleted2 = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => deleteStaleCalendarEvents(tx, fx.schoolA, []),
      APP,
    );
    expect(deleted2).toBe(0);
    await sql`RESET ROLE`;
    const stillThere = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM school_calendar_events WHERE school_id = ${fx.schoolA}
    `;
    expect(stillThere[0].n).toBe("1");
  });

  it("upsertCalendarSource: school_admin が自校設定を upsert（tenant_isolation・冪等）", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const d = drizzle(client);
      const id1 = await withTenantContext(
        d,
        { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
        (tx) =>
          upsertCalendarSource(tx, {
            schoolId: fx.schoolA,
            icsUrl: "https://a.test/v1.ics",
            actorUserId: fx.userA,
          }),
        APP,
      );
      const id2 = await withTenantContext(
        d,
        { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
        (tx) =>
          upsertCalendarSource(tx, {
            schoolId: fx.schoolA,
            icsUrl: "https://a.test/v2.ics",
            actorUserId: fx.userA,
          }),
        APP,
      );
      expect(id2).toBe(id1); // (school_id) 一意で行は増えない

      await client.unsafe("RESET ROLE");
      const rows = await client<
        { ics_url: string; created_by: string | null }[]
      >`SELECT ics_url, created_by FROM school_calendar_sources WHERE school_id = ${fx.schoolA}`;
      expect(rows.length).toBe(1);
      expect(rows[0].ics_url).toBe("https://a.test/v2.ics");
      expect(rows[0].created_by).toBe(fx.userA); // actor を記録（ルール1）
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("getCalendarEvents: 自校 context で startDate レンジ昇順、他校は混入しない", async () => {
    await seedEvent(fx.schoolA, "a-1", "2026-04-08", "行事1");
    await seedEvent(fx.schoolA, "a-2", "2026-04-20", "行事2");
    await seedEvent(fx.schoolA, "a-3", "2026-05-10", "範囲外");
    await seedEvent(fx.schoolB, "b-1", "2026-04-10", "他校");

    const events = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "student" },
      (tx) => getCalendarEvents(tx, fx.schoolA, "2026-04-01", "2026-04-30"),
      APP,
    );
    expect(events.map((e) => e.uid)).toEqual(["a-1", "a-2"]); // 範囲内・昇順・他校なし
  });
});
