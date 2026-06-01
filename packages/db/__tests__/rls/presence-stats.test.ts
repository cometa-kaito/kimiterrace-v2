import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getDailyPresenceCounts, getHourlyPresenceCounts } from "../../src/queries/event-stats.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F08 (#44): 人感ヒートマップ read 層 getHourlyPresenceCounts を実 PG (RLS 込み) で検証する。
 *
 * 観点: (1) `events.type='presence'` のみを JST の時 (hour-of-day) ごとに集計し view/tap を除外、
 * (2) JST 変換が正しい (UTC のまま取らない)、(3) 期間窓 (sinceDays) が DB now() 基準で効く、
 * (4) **テナント分離** — 別校の presence が漏れない (CLAUDE.md ルール2)、(5) 空コンテキストは
 * deny-by-default で 0 件。
 *
 * occurred_at は JS Date を bind せず DB 側で構築する ([[pg-date-bind-enum-insert]]: postgres@3.4.9 は
 * enum 列を含む INSERT で timestamptz の Date を直列化できない)。DATABASE_URL 未設定ならローカルは
 * skip、CI (実 PG16) で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("F08 getHourlyPresenceCounts (人感ヒートマップ read、JST hour + RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxA = () => ({ schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ schoolId: fx.schoolB, role: "school_admin" as const });

  // 特定の JST 時 (hour-of-day) に event を投入する。occurred_at は DB 側で「2 日前の JST 暦日の
  // ${jstHour}:00 JST」を構築する (event-stats.test.ts と同方針、[[pg-date-bind-enum-insert]])。
  // 2 日前なら既定 30 日窓内かつ過去で、extract(hour ...) は jstHour と一致する。
  async function seedAtHour(
    schoolId: string,
    type: "view" | "tap" | "presence",
    jstHour: number,
  ): Promise<void> {
    await raw`
      INSERT INTO events (school_id, type, occurred_at)
      VALUES (
        ${schoolId}, ${type},
        (date_trunc('day', now() at time zone 'Asia/Tokyo')
          - make_interval(days => 2)
          + make_interval(hours => ${jstHour}::int)) at time zone 'Asia/Tokyo'
      )
    `;
  }

  // 期間窓テスト用: ${daysAgo} 日前に投入 (hour は now() の時刻、窓の内外判定にのみ使う)。
  async function seedDaysAgo(
    schoolId: string,
    type: "view" | "tap" | "presence",
    daysAgo: number,
  ): Promise<void> {
    await raw`
      INSERT INTO events (school_id, type, occurred_at)
      VALUES (${schoolId}, ${type}, now() - make_interval(days => ${daysAgo}::int))
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM events`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("presence のみを JST の時ごとに集計し時昇順で返す (view/tap は除外)", async () => {
    await seedAtHour(fx.schoolA, "presence", 8);
    await seedAtHour(fx.schoolA, "presence", 8);
    await seedAtHour(fx.schoolA, "presence", 13);
    // 同じ時間帯の view/tap は presence 集計に混ざらないこと
    await seedAtHour(fx.schoolA, "view", 8);
    await seedAtHour(fx.schoolA, "tap", 13);

    const rows = await withTenantContext(db, ctxA(), (tx) => getHourlyPresenceCounts(tx), APP);
    expect(rows).toEqual([
      { hour: 8, presence: 2 },
      { hour: 13, presence: 1 },
    ]);
  });

  it("テナント分離: 別校の presence は漏れない (RLS)", async () => {
    await seedAtHour(fx.schoolA, "presence", 9);
    await seedAtHour(fx.schoolB, "presence", 9);
    await seedAtHour(fx.schoolB, "presence", 9);

    const a = await withTenantContext(db, ctxA(), (tx) => getHourlyPresenceCounts(tx), APP);
    expect(a).toEqual([{ hour: 9, presence: 1 }]);

    const b = await withTenantContext(db, ctxB(), (tx) => getHourlyPresenceCounts(tx), APP);
    expect(b).toEqual([{ hour: 9, presence: 2 }]);
  });

  it("sinceDays 窓外の presence は含めない (DB now() 基準)", async () => {
    await seedDaysAgo(fx.schoolA, "presence", 1); // 窓内
    await seedDaysAgo(fx.schoolA, "presence", 40); // 既定 30 日窓外

    const def = await withTenantContext(db, ctxA(), (tx) => getHourlyPresenceCounts(tx), APP);
    expect(def.reduce((s, r) => s + r.presence, 0)).toBe(1);

    const wide = await withTenantContext(
      db,
      ctxA(),
      (tx) => getHourlyPresenceCounts(tx, { sinceDays: 90 }),
      APP,
    );
    expect(wide.reduce((s, r) => s + r.presence, 0)).toBe(2);
  });

  it("deny-by-default: 空コンテキストは 0 件", async () => {
    await seedAtHour(fx.schoolA, "presence", 8);
    const rows = await withTenantContext(db, {}, (tx) => getHourlyPresenceCounts(tx), APP);
    expect(rows).toEqual([]);
  });
});

describeOrSkip("F08 getDailyPresenceCounts (在室の日次推移 read、JST 暦日 + RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxA = () => ({ schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ schoolId: fx.schoolB, role: "school_admin" as const });

  // ${daysAgo} 日前に event を投入する。occurred_at は DB 側で算出 ([[pg-date-bind-enum-insert]])。
  // JST 暦日を確実に分けるため呼び出し側は 2 日以上離して seed する (深夜境界の取り違え回避)。
  async function seedDaysAgo(
    schoolId: string,
    type: "view" | "tap" | "presence",
    daysAgo: number,
  ): Promise<void> {
    await raw`
      INSERT INTO events (school_id, type, occurred_at)
      VALUES (${schoolId}, ${type}, now() - make_interval(days => ${daysAgo}::int))
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM events`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("presence のみを JST 暦日ごとに日付昇順で集計 (view/tap は除外)", async () => {
    // 3 日前に presence ×2、1 日前に presence ×1。同日に view/tap も混ぜて除外を確認。
    await seedDaysAgo(fx.schoolA, "presence", 3);
    await seedDaysAgo(fx.schoolA, "presence", 3);
    await seedDaysAgo(fx.schoolA, "presence", 1);
    await seedDaysAgo(fx.schoolA, "view", 3);
    await seedDaysAgo(fx.schoolA, "tap", 1);

    const rows = await withTenantContext(db, ctxA(), (tx) => getDailyPresenceCounts(tx), APP);
    // 2 つの暦日。日付昇順 (古い=3日前 → 新しい=1日前)、presence のみ。
    expect(rows).toHaveLength(2);
    expect(rows[0].presence).toBe(2);
    expect(rows[1].presence).toBe(1);
    expect(rows[0].day < rows[1].day).toBe(true);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(rows[0].day)).toBe(true);
  });

  it("テナント分離: 別校の presence は日次集計に漏れない (RLS)", async () => {
    await seedDaysAgo(fx.schoolA, "presence", 2);
    await seedDaysAgo(fx.schoolB, "presence", 2);
    await seedDaysAgo(fx.schoolB, "presence", 2);

    const a = await withTenantContext(db, ctxA(), (tx) => getDailyPresenceCounts(tx), APP);
    expect(a.reduce((s, r) => s + r.presence, 0)).toBe(1);

    const b = await withTenantContext(db, ctxB(), (tx) => getDailyPresenceCounts(tx), APP);
    expect(b.reduce((s, r) => s + r.presence, 0)).toBe(2);
  });

  it("sinceDays 窓外の presence は含めない (DB now() 基準)", async () => {
    await seedDaysAgo(fx.schoolA, "presence", 2); // 窓内
    await seedDaysAgo(fx.schoolA, "presence", 40); // 既定 30 日窓外

    const def = await withTenantContext(db, ctxA(), (tx) => getDailyPresenceCounts(tx), APP);
    expect(def.reduce((s, r) => s + r.presence, 0)).toBe(1);

    const wide = await withTenantContext(
      db,
      ctxA(),
      (tx) => getDailyPresenceCounts(tx, { sinceDays: 90 }),
      APP,
    );
    expect(wide.reduce((s, r) => s + r.presence, 0)).toBe(2);
  });

  it("deny-by-default: 空コンテキストは 0 件", async () => {
    await seedDaysAgo(fx.schoolA, "presence", 1);
    const rows = await withTenantContext(db, {}, (tx) => getDailyPresenceCounts(tx), APP);
    expect(rows).toEqual([]);
  });
});
