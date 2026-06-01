import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  getDailyEventCounts,
  getEventStats,
  getEventStatsBySchool,
} from "../../src/queries/event-stats.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F08 (#44): 効果集計 read 層を実 PG (RLS 込み) で検証する。
 *
 * 観点: (1) type 別 totals と content ランキングの集計正当性、(2) 期間窓 (sinceDays) が DB now()
 * 基準で効くこと、(3) content_id NULL の event は ranking から除外され totals には含むこと、
 * (4) **テナント分離** — 別校の events が集計に漏れないこと (CLAUDE.md ルール2)、(5) 空コンテキストは
 * deny-by-default で 0 件、(6) rankingLimit が効くこと。
 */
describeOrSkip("F08 getEventStats (効果集計 read、RLS + 集計正当性)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let contentA1: string;
  let contentA2: string;
  let contentB1: string;

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" as const });

  async function seedContent(schoolId: string, title: string): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status)
      VALUES (${schoolId}, ${title}, '本文', 'school', 'published')
      RETURNING id
    `;
    return row.id;
  }

  // events は BYPASSRLS 接続 (postgres スーパーユーザー) で直接投入する。occurred_at は DB 側で
  // `now() - make_interval(days => N)` として算出する (JS Date を bind すると postgres@3.4.9 が
  // enum 列を含む INSERT で timestamptz パラメータの Date を直列化できず ERR_INVALID_ARG_TYPE に
  // なるため。DB 時刻基準で期間窓を再現でき、本体クエリの now() 基準とも揃う)。content_id は NULL も許容。
  async function seedEvent(
    schoolId: string,
    contentId: string | null,
    type: "view" | "tap" | "ask",
    daysAgo: number,
  ): Promise<void> {
    await raw`
      INSERT INTO events (school_id, content_id, type, occurred_at)
      VALUES (${schoolId}, ${contentId}, ${type}, now() - make_interval(days => ${daysAgo}::int))
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    // events を先に消してから contents (FK content_id ON DELETE set null で順序非依存だが明示)。
    await raw`DELETE FROM events`;
    await raw`DELETE FROM contents`;
    contentA1 = await seedContent(fx.schoolA, "体育祭のお知らせ");
    contentA2 = await seedContent(fx.schoolA, "文化祭のお知らせ");
    contentB1 = await seedContent(fx.schoolB, "B 校の告知");
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("集計正当性: type 別 totals と content 別 ranking を返す", async () => {
    // A1: view×3 + tap×2 (total 5)、A2: view×1 (total 1)
    for (let i = 0; i < 3; i++) await seedEvent(fx.schoolA, contentA1, "view", 1);
    for (let i = 0; i < 2; i++) await seedEvent(fx.schoolA, contentA1, "tap", 1);
    await seedEvent(fx.schoolA, contentA2, "view", 1);

    const stats = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 4, tap: 2, ask: 0 });
    expect(stats.ranking).toEqual([
      { contentId: contentA1, title: "体育祭のお知らせ", views: 3, taps: 2, total: 5 },
      { contentId: contentA2, title: "文化祭のお知らせ", views: 1, taps: 0, total: 1 },
    ]);
  });

  it("Q&A (ask) 件数: totals.ask に反映、ranking には混ぜない (F06 経路の Q&A)", async () => {
    // ask は F06 生徒対話の経路で記録される (content 紐付けなしの Q&A もありうる)。
    await seedEvent(fx.schoolA, contentA1, "view", 1);
    await seedEvent(fx.schoolA, contentA1, "ask", 1);
    await seedEvent(fx.schoolA, null, "ask", 1);

    const stats = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 1, tap: 0, ask: 2 });
    // ranking は WHERE で view/tap に限定するため ask は寄与しない。contentA1 は view 1 件だけで
    // 拾われ total=views+taps が保たれる (ask は totals.ask にのみ計上)。
    expect(stats.ranking).toEqual([
      { contentId: contentA1, title: "体育祭のお知らせ", views: 1, taps: 0, total: 1 },
    ]);
  });

  it("期間窓: sinceDays より古い event は totals/ranking に含めない (DB now() 基準)", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", 1); // 範囲内
    await seedEvent(fx.schoolA, contentA1, "view", 40); // 既定 30 日の範囲外
    const stats = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 1, tap: 0, ask: 0 });
    expect(stats.ranking).toEqual([
      { contentId: contentA1, title: "体育祭のお知らせ", views: 1, taps: 0, total: 1 },
    ]);

    // sinceDays を広げれば古い event も入る
    const wide = await withTenantContext(
      db,
      ctxA(),
      (tx) => getEventStats(tx, { sinceDays: 90 }),
      APP,
    );
    expect(wide.totals).toEqual({ view: 2, tap: 0, ask: 0 });
  });

  it("content_id NULL の event は ranking から除外し totals には含む", async () => {
    await seedEvent(fx.schoolA, null, "tap", 1); // 広告枠そのものへの tap 想定
    await seedEvent(fx.schoolA, contentA1, "view", 1);
    const stats = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 1, tap: 1, ask: 0 });
    // ranking には content_id を持つ A1 のみ (NULL 行は出ない)
    expect(stats.ranking.map((r) => r.contentId)).toEqual([contentA1]);
  });

  it("テナント分離: A コンテキストからは B 校の events が一切集計に漏れない (RLS)", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", 1);
    await seedEvent(fx.schoolB, contentB1, "view", 1);
    await seedEvent(fx.schoolB, contentB1, "tap", 1);

    const a = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(a.totals).toEqual({ view: 1, tap: 0, ask: 0 });
    expect(a.ranking.map((r) => r.contentId)).toEqual([contentA1]);

    const b = await withTenantContext(db, ctxB(), (tx) => getEventStats(tx), APP);
    expect(b.totals).toEqual({ view: 1, tap: 1, ask: 0 });
    expect(b.ranking.map((r) => r.contentId)).toEqual([contentB1]);
  });

  it("空コンテキストは deny-by-default で totals 0 + ranking 空", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", 1);
    const stats = await withTenantContext(db, {}, (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 0, tap: 0, ask: 0 });
    expect(stats.ranking).toEqual([]);
  });

  it("rankingLimit: 上位 N 件だけ返す (total 降順)", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", 1);
    await seedEvent(fx.schoolA, contentA1, "view", 1); // A1 total 2
    await seedEvent(fx.schoolA, contentA2, "view", 1); // A2 total 1
    const stats = await withTenantContext(
      db,
      ctxA(),
      (tx) => getEventStats(tx, { rankingLimit: 1 }),
      APP,
    );
    expect(stats.ranking.map((r) => r.contentId)).toEqual([contentA1]);
  });

  // --- getDailyEventCounts (時系列) ---

  it("getDailyEventCounts: JST 暦日ごとに view/tap を日付昇順で集計", async () => {
    // 2 日以上離して seed すれば JST 暦日が確実に分かれる (深夜境界の取り違えを回避)。
    await seedEvent(fx.schoolA, contentA1, "view", 0); // 今日
    await seedEvent(fx.schoolA, contentA1, "view", 0); // 今日
    await seedEvent(fx.schoolA, contentA1, "tap", 0); // 今日
    await seedEvent(fx.schoolA, contentA1, "view", 2); // 2 日前
    await seedEvent(fx.schoolA, contentA2, "view", 5); // 5 日前 (既定 30 日窓内)

    const daily = await withTenantContext(db, ctxA(), (tx) => getDailyEventCounts(tx), APP);
    expect(daily.length).toBe(3);
    // 日付昇順
    const days = daily.map((d) => d.day);
    expect([...days].sort()).toEqual(days);
    // 最新日 (= 今日) は view×2 / tap×1
    expect(daily[daily.length - 1]).toEqual({ day: days[2], views: 2, taps: 1 });
    // 全期間合計
    expect(daily.reduce((s, d) => s + d.views, 0)).toBe(4);
    expect(daily.reduce((s, d) => s + d.taps, 0)).toBe(1);
  });

  it("getDailyEventCounts: sinceDays 窓外 / 別テナントの event は含めない", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", 1); // 範囲内
    await seedEvent(fx.schoolA, contentA1, "view", 40); // 既定 30 日の範囲外
    await seedEvent(fx.schoolB, contentB1, "view", 1); // 別校 (RLS で不可視)

    const daily = await withTenantContext(db, ctxA(), (tx) => getDailyEventCounts(tx), APP);
    expect(daily.length).toBe(1);
    expect(daily[0].views).toBe(1);

    // 窓を広げれば窓外の日も現れる (= 2 日分)
    const wide = await withTenantContext(
      db,
      ctxA(),
      (tx) => getDailyEventCounts(tx, { sinceDays: 90 }),
      APP,
    );
    expect(wide.length).toBe(2);
  });

  // --- getEventStatsBySchool (全校横断、system_admin 専用) ---

  // system_admin コンテキスト: app.current_user_role='system_admin' で全校行に
  // system_admin_full_access policy が発火する (schoolId は張らない = 横断)。
  const ctxSys = () => ({ role: "system_admin" as const });

  it("getEventStatsBySchool: system_admin は全校の学校別サマリーを反応数降順で返す", async () => {
    // A: view×3 + tap×2 (反応 5) + ask×1、B: view×1 (反応 1)
    for (let i = 0; i < 3; i++) await seedEvent(fx.schoolA, contentA1, "view", 1);
    for (let i = 0; i < 2; i++) await seedEvent(fx.schoolA, contentA1, "tap", 1);
    await seedEvent(fx.schoolA, null, "ask", 1);
    await seedEvent(fx.schoolB, contentB1, "view", 1);

    const rows = await withTenantContext(db, ctxSys(), (tx) => getEventStatsBySchool(tx), APP);
    expect(rows).toEqual([
      {
        schoolId: fx.schoolA,
        schoolName: "テスト高校 A",
        prefecture: "岐阜県",
        totals: { view: 3, tap: 2, ask: 1 },
        reactions: 5,
      },
      {
        schoolId: fx.schoolB,
        schoolName: "テスト高校 B",
        prefecture: "岐阜県",
        totals: { view: 1, tap: 0, ask: 0 },
        reactions: 1,
      },
    ]);
  });

  it("getEventStatsBySchool: テナントロール (school_admin) は自校 1 行だけ (RLS 多層防御)", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", 1);
    await seedEvent(fx.schoolB, contentB1, "view", 1);
    await seedEvent(fx.schoolB, contentB1, "tap", 1);

    // A コンテキストでは tenant_isolation により自校行のみ可視 = A 校 1 行。
    const rows = await withTenantContext(db, ctxA(), (tx) => getEventStatsBySchool(tx), APP);
    expect(rows.map((r) => r.schoolId)).toEqual([fx.schoolA]);
    expect(rows[0].totals).toEqual({ view: 1, tap: 0, ask: 0 });
  });

  it("getEventStatsBySchool: 空コンテキストは deny-by-default で空配列", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", 1);
    await seedEvent(fx.schoolB, contentB1, "view", 1);
    const rows = await withTenantContext(db, {}, (tx) => getEventStatsBySchool(tx), APP);
    expect(rows).toEqual([]);
  });

  it("getEventStatsBySchool: sinceDays 窓外の event を含めず、活動ゼロの校は行に出さない", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", 1); // 範囲内
    await seedEvent(fx.schoolA, contentA1, "view", 40); // 既定 30 日の範囲外
    // B 校は窓外 event のみ → 行として現れない
    await seedEvent(fx.schoolB, contentB1, "view", 40);

    const rows = await withTenantContext(db, ctxSys(), (tx) => getEventStatsBySchool(tx), APP);
    expect(rows.map((r) => r.schoolId)).toEqual([fx.schoolA]);
    expect(rows[0].totals.view).toBe(1);

    // 窓を広げれば B 校も現れる (2 校)
    const wide = await withTenantContext(
      db,
      ctxSys(),
      (tx) => getEventStatsBySchool(tx, { sinceDays: 90 }),
      APP,
    );
    expect(wide.map((r) => r.schoolId).sort()).toEqual([fx.schoolA, fx.schoolB].sort());
  });
});
