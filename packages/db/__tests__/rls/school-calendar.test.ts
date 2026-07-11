import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  deleteStaleCalendarEvents,
  getCalendarEvents,
  listEnabledCalendarSources,
  replaceFileImportedEvents,
  sanitizeIcalEventUid,
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

  // owner（BYPASSRLS）でイベント行をシードするヘルパ。sourceId 省略時は null（ファイル取込 / orphan 相当）。
  async function seedEvent(
    schoolId: string,
    uid: string,
    startDate: string,
    summary = "行事",
    sourceId: string | null = null,
  ): Promise<void> {
    await sql`
      INSERT INTO school_calendar_events (school_id, uid, start_date, summary, source_id)
      VALUES (${schoolId}, ${uid}, ${startDate}, ${summary}, ${sourceId})
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

  it("deleteStaleCalendarEvents: 同期中ソースの keepUids に無い行のみ掃除 / keepUids 空は no-op（last-known-good）", async () => {
    const srcA = await seedSource(fx.schoolA, "https://a.test/cal.ics");
    await seedEvent(fx.schoolA, "keep-1", "2026-04-08", "行事", srcA);
    await seedEvent(fx.schoolA, "stale-1", "2026-04-09", "行事", srcA);
    await seedEvent(fx.schoolB, "other-1", "2026-04-10");

    // keepUids=["keep-1"] → 同一ソースの stale-1 のみ削除。他校 other-1 は触らない（school_id 明示で絞る）。
    const deleted = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => deleteStaleCalendarEvents(tx, fx.schoolA, srcA, ["keep-1"]),
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
      (tx) => deleteStaleCalendarEvents(tx, fx.schoolA, srcA, []),
      APP,
    );
    expect(deleted2).toBe(0);
    await sql`RESET ROLE`;
    const stillThere = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM school_calendar_events WHERE school_id = ${fx.schoolA}
    `;
    expect(stillThere[0].n).toBe("1");
  });

  it("★ deleteStaleCalendarEvents: 別ソース由来 / sourceId=null（ファイル取込・orphan）の行を巻き込まない（ADR-049 決定 2）", async () => {
    // 同一校に 2 つの iCal ソース + sourceId=null のファイル取込 / orphan 行を混在させる。
    const srcA = await seedSource(fx.schoolA, "https://a.test/cal.ics");
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO school_calendar_sources (school_id, ics_url, enabled)
      VALUES (${fx.schoolB}, 'https://b.test/cal.ics', true)
      RETURNING id
    `;
    const srcB = row.id; // 別ソース（校が別でも sourceId 条件の検証には十分）
    await seedEvent(fx.schoolA, "a-keep", "2026-04-08", "行事", srcA);
    await seedEvent(fx.schoolA, "a-stale", "2026-04-09", "行事", srcA);
    await seedEvent(fx.schoolA, "file:batch-1:1", "2026-04-10", "ファイル取込", null);
    await seedEvent(fx.schoolA, "orphan-ical", "2026-04-11", "orphan", null);
    await seedEvent(fx.schoolB, "b-1", "2026-04-12", "行事", srcB);

    // srcA の同期掃除: keepUids に無い a-stale だけが消え、sourceId=null 行（file: / orphan）と別ソース行は残る。
    // 旧実装（school 単位の全削除）ではファイル取込行事が誤削除されていた回帰を固定する。
    const deleted = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => deleteStaleCalendarEvents(tx, fx.schoolA, srcA, ["a-keep"]),
      APP,
    );
    expect(deleted).toBe(1);

    await sql`RESET ROLE`;
    const aRows = await sql<{ uid: string }[]>`
      SELECT uid FROM school_calendar_events WHERE school_id = ${fx.schoolA} ORDER BY uid
    `;
    expect(aRows.map((r) => r.uid)).toEqual(["a-keep", "file:batch-1:1", "orphan-ical"]);
    const bRows = await sql<{ uid: string }[]>`
      SELECT uid FROM school_calendar_events WHERE school_id = ${fx.schoolB}
    `;
    expect(bRows.map((r) => r.uid)).toEqual(["b-1"]);
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

  // ---- ADR-049: ファイル取込（file: 名前空間の置き換え）----

  it("★ replaceFileImportedEvents: 教員セッションで自校の file: バッチを置き換え（旧バッチ削除 + 新バッチ挿入・監査・raw 保全）", async () => {
    const srcA = await seedSource(fx.schoolA, "https://a.test/cal.ics");
    // 置き換え対象: 旧ファイル取込バッチ（sourceId=null・file: uid）。
    await seedEvent(fx.schoolA, "file:old-batch:1", "2026-04-08", "旧取込1", null);
    await seedEvent(fx.schoolA, "file:old-batch:2", "2026-04-09", "旧取込2", null);
    // 保護対象: iCal 由来（sourceId 非 null。file: uid が紛れても source_id IS NULL 条件で守られる）
    // + ical: リライト行 + orphan（sourceId=null・非 file:）。
    await seedEvent(fx.schoolA, "ical-evt", "2026-04-10", "iCal行事", srcA);
    await seedEvent(fx.schoolA, "file:invaded", "2026-04-11", "iCal侵食試行", srcA);
    await seedEvent(
      fx.schoolA,
      sanitizeIcalEventUid("file:rewritten"),
      "2026-04-12",
      "リライト済",
      srcA,
    );
    await seedEvent(fx.schoolA, "orphan-ical", "2026-04-13", "orphan", null);

    const result = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) =>
        replaceFileImportedEvents(tx, {
          schoolId: fx.schoolA,
          batchId: "batch-2",
          fileName: "年間行事予定表.xlsx",
          actorUserId: fx.userA,
          events: [
            { summary: "始業式", startDate: "2026-04-08", allDay: true },
            {
              summary: "体育祭",
              startDate: "2026-09-10",
              endDate: "2026-09-11",
              location: "グラウンド",
            },
          ],
        }),
      APP,
    );
    expect(result.deleted).toBe(2); // file:old-batch のみ（iCal 由来 / ical: / orphan は残る）
    expect(result.inserted).toBe(2);

    await sql`RESET ROLE`;
    const rows = await sql<
      {
        uid: string;
        summary: string;
        source_id: string | null;
        created_by: string | null;
        raw: unknown;
      }[]
    >`
      SELECT uid, summary, source_id, created_by, raw FROM school_calendar_events
      WHERE school_id = ${fx.schoolA} ORDER BY uid
    `;
    expect(rows.map((r) => r.uid)).toEqual([
      "file:batch-2:1",
      "file:batch-2:2",
      "file:invaded",
      "ical-evt",
      "ical:file:rewritten",
      "orphan-ical",
    ]);
    const inserted = rows.filter((r) => r.uid.startsWith("file:batch-2:"));
    for (const r of inserted) {
      expect(r.source_id).toBeNull(); // ファイル取込は sourceId=null（ADR-049 決定 1）
      expect(r.created_by).toBe(fx.userA); // 実行者を記録（ルール1）
      expect(r.raw).toEqual({
        origin: "file-import",
        batchId: "batch-2",
        fileName: "年間行事予定表.xlsx",
        importedBy: fx.userA,
      });
    }
    // 置き換え後に自校 context で読める（getCalendarEvents 再利用、PR-D の読み口）。
    const readBack = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) => getCalendarEvents(tx, fx.schoolA, "2026-09-01", "2026-09-30"),
      APP,
    );
    expect(readBack.map((e) => e.summary)).toEqual(["体育祭"]);
  });

  it("★ replaceFileImportedEvents: 空バッチは意図的なクリア（file: のみ全削除・挿入 0）", async () => {
    const srcA = await seedSource(fx.schoolA, "https://a.test/cal.ics");
    await seedEvent(fx.schoolA, "file:old:1", "2026-04-08", "旧取込", null);
    await seedEvent(fx.schoolA, "ical-evt", "2026-04-10", "iCal行事", srcA);

    const result = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) =>
        replaceFileImportedEvents(tx, {
          schoolId: fx.schoolA,
          batchId: "batch-empty",
          fileName: "empty.csv",
          actorUserId: fx.userA,
          events: [],
        }),
      APP,
    );
    expect(result).toEqual({ deleted: 1, inserted: 0 });

    await sql`RESET ROLE`;
    const rows = await sql<{ uid: string }[]>`
      SELECT uid FROM school_calendar_events WHERE school_id = ${fx.schoolA}
    `;
    expect(rows.map((r) => r.uid)).toEqual(["ical-evt"]);
  });

  it("★ replaceFileImportedEvents: 他校スコープでは書けない（WITH CHECK 拒否）・他校の file: 行は消せない（USING 不可視）", async () => {
    await seedEvent(fx.schoolB, "file:b-batch:1", "2026-04-08", "他校の取込", null);

    // school A の教員 context から school B への置き換え: INSERT は WITH CHECK で拒否。
    // ★ drizzle ヘルパ経由のエラーは "Failed query: ..." にラップされ RLS メッセージは error.cause 側に移る
    //   （[[ref_drizzle_wraps_pg_error_cause_sqlstate]]）ため、message regex ではなく bare toThrow + 下の
    //   「他校行が無傷」の否定アサーションで拒否を担保する（ai-extractions.test.ts の precedent と同じ）。
    await expect(
      withTenantContext(
        db,
        { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
        (tx) =>
          replaceFileImportedEvents(tx, {
            schoolId: fx.schoolB,
            batchId: "evil-batch",
            fileName: "evil.xlsx",
            actorUserId: fx.userA,
            events: [{ summary: "侵入", startDate: "2026-04-08" }],
          }),
        APP,
      ),
    ).rejects.toThrow();

    // 他校行は USING で不可視のため削除もされていない（挿入 0 のクリア試行でも消せない）。
    const result = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) =>
        replaceFileImportedEvents(tx, {
          schoolId: fx.schoolB,
          batchId: "evil-batch",
          fileName: "evil.xlsx",
          actorUserId: fx.userA,
          events: [],
        }),
      APP,
    );
    expect(result).toEqual({ deleted: 0, inserted: 0 });

    await sql`RESET ROLE`;
    const bRows = await sql<{ uid: string }[]>`
      SELECT uid FROM school_calendar_events WHERE school_id = ${fx.schoolB}
    `;
    expect(bRows.map((r) => r.uid)).toEqual(["file:b-batch:1"]); // 他校は無傷
  });
});

describe("sanitizeIcalEventUid（ADR-049 決定 2: iCal 側の file: 名前空間強制）", () => {
  it("file: で始まる uid は ical: を前置してリライトする", () => {
    expect(sanitizeIcalEventUid("file:evil:1")).toBe("ical:file:evil:1");
  });

  it("file: 以外はそのまま（既存 iCal uid の冪等性を壊さない）", () => {
    expect(sanitizeIcalEventUid("evt-1")).toBe("evt-1");
    expect(sanitizeIcalEventUid("ical:file:x")).toBe("ical:file:x"); // 再適用も不変（決定的）
  });

  it("リライトで varchar(512) を超える場合は 512 文字にクランプ（決定的）", () => {
    const long = `file:${"x".repeat(510)}`; // 515 文字
    const out = sanitizeIcalEventUid(long);
    expect(out.length).toBe(512);
    expect(out.startsWith("ical:file:")).toBe(true);
    expect(sanitizeIcalEventUid(long)).toBe(out); // 冪等入力 → 同一出力
  });
});
