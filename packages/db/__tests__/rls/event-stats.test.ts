import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getEventStats } from "../../src/queries/event-stats.js";
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

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  async function seedContent(schoolId: string, title: string): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status)
      VALUES (${schoolId}, ${title}, '本文', 'school', 'published')
      RETURNING id
    `;
    return row.id;
  }

  // events は BYPASSRLS 接続 (postgres スーパーユーザー) で直接投入する。occurred_at は JS Date を
  // bind し timestamptz として保存 (期間窓テスト用に明示)。content_id は NULL も許容。
  async function seedEvent(
    schoolId: string,
    contentId: string | null,
    type: "view" | "tap",
    occurredAt: Date,
  ): Promise<void> {
    await raw`
      INSERT INTO events (school_id, content_id, type, occurred_at)
      VALUES (${schoolId}, ${contentId}, ${type}, ${occurredAt})
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
    for (let i = 0; i < 3; i++) await seedEvent(fx.schoolA, contentA1, "view", daysAgo(1));
    for (let i = 0; i < 2; i++) await seedEvent(fx.schoolA, contentA1, "tap", daysAgo(1));
    await seedEvent(fx.schoolA, contentA2, "view", daysAgo(1));

    const stats = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 4, tap: 2 });
    expect(stats.ranking).toEqual([
      { contentId: contentA1, title: "体育祭のお知らせ", views: 3, taps: 2, total: 5 },
      { contentId: contentA2, title: "文化祭のお知らせ", views: 1, taps: 0, total: 1 },
    ]);
  });

  it("期間窓: sinceDays より古い event は totals/ranking に含めない (DB now() 基準)", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", daysAgo(1)); // 範囲内
    await seedEvent(fx.schoolA, contentA1, "view", daysAgo(40)); // 既定 30 日の範囲外
    const stats = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 1, tap: 0 });
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
    expect(wide.totals).toEqual({ view: 2, tap: 0 });
  });

  it("content_id NULL の event は ranking から除外し totals には含む", async () => {
    await seedEvent(fx.schoolA, null, "tap", daysAgo(1)); // 広告枠そのものへの tap 想定
    await seedEvent(fx.schoolA, contentA1, "view", daysAgo(1));
    const stats = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 1, tap: 1 });
    // ranking には content_id を持つ A1 のみ (NULL 行は出ない)
    expect(stats.ranking.map((r) => r.contentId)).toEqual([contentA1]);
  });

  it("テナント分離: A コンテキストからは B 校の events が一切集計に漏れない (RLS)", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", daysAgo(1));
    await seedEvent(fx.schoolB, contentB1, "view", daysAgo(1));
    await seedEvent(fx.schoolB, contentB1, "tap", daysAgo(1));

    const a = await withTenantContext(db, ctxA(), (tx) => getEventStats(tx), APP);
    expect(a.totals).toEqual({ view: 1, tap: 0 });
    expect(a.ranking.map((r) => r.contentId)).toEqual([contentA1]);

    const b = await withTenantContext(db, ctxB(), (tx) => getEventStats(tx), APP);
    expect(b.totals).toEqual({ view: 1, tap: 1 });
    expect(b.ranking.map((r) => r.contentId)).toEqual([contentB1]);
  });

  it("空コンテキストは deny-by-default で totals 0 + ranking 空", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", daysAgo(1));
    const stats = await withTenantContext(db, {}, (tx) => getEventStats(tx), APP);
    expect(stats.totals).toEqual({ view: 0, tap: 0 });
    expect(stats.ranking).toEqual([]);
  });

  it("rankingLimit: 上位 N 件だけ返す (total 降順)", async () => {
    await seedEvent(fx.schoolA, contentA1, "view", daysAgo(1));
    await seedEvent(fx.schoolA, contentA1, "view", daysAgo(1)); // A1 total 2
    await seedEvent(fx.schoolA, contentA2, "view", daysAgo(1)); // A2 total 1
    const stats = await withTenantContext(
      db,
      ctxA(),
      (tx) => getEventStats(tx, { rankingLimit: 1 }),
      APP,
    );
    expect(stats.ranking.map((r) => r.contentId)).toEqual([contentA1]);
  });
});
