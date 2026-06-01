import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getMonthlySchoolSummary } from "../../src/queries/monthly-report.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F09 (#45): 学校別 月次サマリー集計 read 層を実 PG (RLS 込み) で検証する。
 *
 * 観点: (1) JST 暦月で type 別 totals と content ランキングを集計、(2) **JST 月境界**が正しい
 * (UTC のまま丸めると前月へずれる深夜帯を当月に寄せる)、(3) 稼働日数 = 月内に event があった JST
 * 暦日の distinct 数、(4) ask は totals.ask のみで ranking に混ぜない / content_id NULL は ranking
 * から除外し totals には含む、(5) **テナント分離** — 別校の events が漏れない (CLAUDE.md ルール2)、
 * (6) 空コンテキストは deny-by-default で 0、(7) rankingLimit、(8) 月範囲外は RangeError。
 */
describeOrSkip("F09 getMonthlySchoolSummary (月次集計 read、RLS + JST 月境界)", () => {
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

  // events は BYPASSRLS 接続で直接投入する。occurred_at は make_timestamptz で **JST の特定日時**として
  // DB 側で構築する (JS Date を bind すると postgres@3.4.9 が enum 列を含む INSERT で timestamptz
  // パラメータの Date を直列化できず ERR_INVALID_ARG_TYPE になるため。年/月/日/時を int で渡す)。
  async function seedEventAt(
    schoolId: string,
    contentId: string | null,
    type: "view" | "tap" | "ask",
    year: number,
    month: number,
    day: number,
    hour = 12,
  ): Promise<void> {
    await raw`
      INSERT INTO events (school_id, content_id, type, occurred_at)
      VALUES (
        ${schoolId}, ${contentId}, ${type},
        make_timestamptz(${year}::int, ${month}::int, ${day}::int, ${hour}::int, 0, 0, 'Asia/Tokyo')
      )
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM events`;
    await raw`DELETE FROM contents`;
    contentA1 = await seedContent(fx.schoolA, "体育祭のお知らせ");
    contentA2 = await seedContent(fx.schoolA, "文化祭のお知らせ");
    contentB1 = await seedContent(fx.schoolB, "B 校の告知");
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("集計正当性: 対象月の type 別 totals と content 別 ranking を返す (他月は除外)", async () => {
    // 2026-06: A1 view×3 + tap×2、A2 view×1。前月(5月)・翌月(7月)の event は対象外。
    for (let i = 0; i < 3; i++) await seedEventAt(fx.schoolA, contentA1, "view", 2026, 6, 10);
    for (let i = 0; i < 2; i++) await seedEventAt(fx.schoolA, contentA1, "tap", 2026, 6, 10);
    await seedEventAt(fx.schoolA, contentA2, "view", 2026, 6, 20);
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 5, 31); // 前月 → 対象外
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 7, 1); // 翌月 → 対象外

    const r = await withTenantContext(
      db,
      ctxA(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6 }),
      APP,
    );
    expect(r.year).toBe(2026);
    expect(r.month).toBe(6);
    expect(r.totals).toEqual({ view: 4, tap: 2, ask: 0 });
    expect(r.ranking).toEqual([
      { contentId: contentA1, title: "体育祭のお知らせ", views: 3, taps: 2, total: 5 },
      { contentId: contentA2, title: "文化祭のお知らせ", views: 1, taps: 0, total: 1 },
    ]);
  });

  it("JST 月境界: 月初 00:00 JST は当月、翌月初 00:00 JST は対象外 (UTC 丸めでずれない)", async () => {
    // JST 6/1 00:00 = UTC 5/31 15:00。UTC のまま月で丸めると 5 月扱いになるが、JST 暦月では 6 月。
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 6, 1, 0); // JST 6/1 00:00 → 6 月
    // JST 7/1 00:00 は翌月境界 (排他) → 対象外
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 7, 1, 0);

    const r = await withTenantContext(
      db,
      ctxA(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6 }),
      APP,
    );
    expect(r.totals.view).toBe(1);
  });

  it("稼働日数: 月内に event があった JST 暦日の distinct 数を返す", async () => {
    // 6/10 に 3 件、6/20 に 1 件 → 稼働 2 日。同日複数は 1 日として数える。
    for (let i = 0; i < 3; i++) await seedEventAt(fx.schoolA, contentA1, "view", 2026, 6, 10);
    await seedEventAt(fx.schoolA, contentA1, "tap", 2026, 6, 20);
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 5, 15); // 前月は数えない

    const r = await withTenantContext(
      db,
      ctxA(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6 }),
      APP,
    );
    expect(r.activeDays).toBe(2);
  });

  it("ask は totals.ask のみ / content_id NULL は ranking から除外し totals には含む", async () => {
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 6, 10);
    await seedEventAt(fx.schoolA, contentA1, "ask", 2026, 6, 10);
    await seedEventAt(fx.schoolA, null, "ask", 2026, 6, 10); // content 紐付けなしの Q&A
    await seedEventAt(fx.schoolA, null, "tap", 2026, 6, 11); // 広告枠そのものへの tap

    const r = await withTenantContext(
      db,
      ctxA(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6 }),
      APP,
    );
    expect(r.totals).toEqual({ view: 1, tap: 1, ask: 2 });
    // ranking は view/tap に限定 + INNER JOIN で content_id NULL を除外 → A1 (view 1) のみ
    expect(r.ranking).toEqual([
      { contentId: contentA1, title: "体育祭のお知らせ", views: 1, taps: 0, total: 1 },
    ]);
  });

  it("テナント分離: A コンテキストからは B 校の events が一切集計に漏れない (RLS)", async () => {
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 6, 10);
    await seedEventAt(fx.schoolB, contentB1, "view", 2026, 6, 10);
    await seedEventAt(fx.schoolB, contentB1, "tap", 2026, 6, 10);

    const a = await withTenantContext(
      db,
      ctxA(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6 }),
      APP,
    );
    expect(a.totals).toEqual({ view: 1, tap: 0, ask: 0 });
    expect(a.ranking.map((x) => x.contentId)).toEqual([contentA1]);
    expect(a.activeDays).toBe(1);

    const b = await withTenantContext(
      db,
      ctxB(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6 }),
      APP,
    );
    expect(b.totals).toEqual({ view: 1, tap: 1, ask: 0 });
    expect(b.ranking.map((x) => x.contentId)).toEqual([contentB1]);
  });

  it("空コンテキストは deny-by-default で totals 0 + ranking 空 + 稼働日数 0", async () => {
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 6, 10);
    const r = await withTenantContext(
      db,
      {},
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6 }),
      APP,
    );
    expect(r.totals).toEqual({ view: 0, tap: 0, ask: 0 });
    expect(r.ranking).toEqual([]);
    expect(r.activeDays).toBe(0);
  });

  it("rankingLimit: 上位 N 件だけ返す (total 降順)", async () => {
    for (let i = 0; i < 2; i++) await seedEventAt(fx.schoolA, contentA1, "view", 2026, 6, 10); // A1 total 2
    await seedEventAt(fx.schoolA, contentA2, "view", 2026, 6, 10); // A2 total 1
    const r = await withTenantContext(
      db,
      ctxA(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6, rankingLimit: 1 }),
      APP,
    );
    expect(r.ranking.map((x) => x.contentId)).toEqual([contentA1]);
  });

  it("月範囲外 (0 / 13 / 非整数) は RangeError で DB に到達しない", async () => {
    await expect(
      withTenantContext(
        db,
        ctxA(),
        (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 0 }),
        APP,
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      withTenantContext(
        db,
        ctxA(),
        (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 13 }),
        APP,
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      withTenantContext(
        db,
        ctxA(),
        (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 6.5 }),
        APP,
      ),
    ).rejects.toThrow(RangeError);
  });

  it("JST 月末境界: 月末日 (JST) の event を当月に計上し翌月初は除外する (UTC セッションで月末を取りこぼさない, #341)", async () => {
    // 7 月窓を検証。旧実装 `monthStart + interval '1 month'` はセッション TZ=UTC のとき
    // 7 月窓を [7/1 00:00 JST, 7/31 00:00 JST) で打ち止め、7/31 (JST) を取りこぼした (上の 6 月境界
    // テストは 5 月が 31 日で偶然クランプ一致するため検知できなかった)。7/31 12:00 JST は 7 月、
    // 8/1 00:00 JST は翌月境界 (排他) で対象外であることを pin する。
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 7, 31); // JST 7/31 12:00 → 7 月 (計上)
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 8, 1, 0); // JST 8/1 00:00 → 翌月 (除外)

    const r = await withTenantContext(
      db,
      ctxA(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 7 }),
      APP,
    );
    expect(r.totals.view).toBe(1);
    expect(r.activeDays).toBe(1);
  });

  it("年跨ぎ: 12 月窓は翌年 1 月初で閉じる (12 月末を計上, #341)", async () => {
    // 12 月は翌月境界が翌年 1 月 → 年跨ぎ。旧実装は UTC で 12 月窓を 12/31 00:00 JST で打ち止め、
    // 12/31 (JST) を取りこぼした。12/31 23:00 JST は 12 月、翌年 1/1 00:00 JST は対象外を pin する。
    await seedEventAt(fx.schoolA, contentA1, "view", 2026, 12, 31, 23); // JST 12/31 23:00 → 12 月 (計上)
    await seedEventAt(fx.schoolA, contentA1, "view", 2027, 1, 1, 0); // JST 翌年 1/1 00:00 → 対象外

    const r = await withTenantContext(
      db,
      ctxA(),
      (tx) => getMonthlySchoolSummary(tx, { year: 2026, month: 12 }),
      APP,
    );
    expect(r.totals.view).toBe(1);
    expect(r.activeDays).toBe(1);
  });
});
