import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { aiRateLimitWindows } from "../../src/schema/ai-rate-limit-windows.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F03 (#347, ADR-027): ai_rate_limit_windows の RLS を実 PG で検証する。
 *
 * 検証ポイント (CLAUDE.md ルール2):
 *   - 自テナント (A) の行が A コンテキストで可視
 *   - 他テナント (B) コンテキストからは A の行が不可視 (USING)
 *   - 他テナントの school_id を埋め込む INSERT は WITH CHECK が拒否
 *   - 越境 UPDATE / DELETE も RLS で 0 行に縮退
 *
 * 接続は DATABASE_URL の superuser (BYPASSRLS) なので、appRole で kimiterrace_app に
 * 降格してから RLS を効かせる (本番は最初から kimiterrace_app 接続)。raw (BYPASSRLS) は
 * 検証用 SELECT に使う。
 */
describeOrSkip("F03 ai_rate_limit_windows RLS (#347, ADR-027)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM ai_rate_limit_windows`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "teacher" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "teacher" as const });

  it("自テナント (A) の INSERT は許可され、A コンテキストで可視 (USING + WITH CHECK)", async () => {
    await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        tx.insert(aiRateLimitWindows).values({
          schoolId: fx.schoolA,
          windowStartMs: 1_700_000_000_000,
          count: 1,
        }),
      APP,
    );

    const visibleUnderA = await withTenantContext(
      db,
      ctxA(),
      (tx) => tx.select().from(aiRateLimitWindows),
      APP,
    );
    expect(visibleUnderA.length).toBe(1);
    expect(visibleUnderA[0].count).toBe(1);
  });

  it("テナント分離 (read): B コンテキストからは A の行が RLS で見えない", async () => {
    await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        tx.insert(aiRateLimitWindows).values({
          schoolId: fx.schoolA,
          windowStartMs: 1_700_000_060_000,
          count: 5,
        }),
      APP,
    );

    const visibleUnderB = await withTenantContext(
      db,
      ctxB(),
      (tx) => tx.select().from(aiRateLimitWindows),
      APP,
    );
    expect(visibleUnderB.length).toBe(0);

    // BYPASSRLS の raw からは存在する (= 隠れているだけで消えていない)。
    const all = await raw`SELECT count FROM ai_rate_limit_windows WHERE school_id = ${fx.schoolA}`;
    expect(all.length).toBe(1);
  });

  it("テナント分離 (write): B コンテキストで A の school_id を埋め込む INSERT は WITH CHECK が弾く", async () => {
    await expect(
      withTenantContext(
        db,
        ctxB(),
        (tx) =>
          tx.insert(aiRateLimitWindows).values({
            schoolId: fx.schoolA, // 越境
            windowStartMs: 1_700_000_120_000,
            count: 1,
          }),
        APP,
      ),
    ).rejects.toThrow();

    const all = await raw`SELECT id FROM ai_rate_limit_windows WHERE school_id = ${fx.schoolA}`;
    expect(all.length).toBe(0);
  });

  it("越境 DELETE は USING で 0 行に縮退 (A の行は B からは消せない)", async () => {
    await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        tx.insert(aiRateLimitWindows).values({
          schoolId: fx.schoolA,
          windowStartMs: 1_700_000_180_000,
          count: 3,
        }),
      APP,
    );

    // B のロールで DELETE しても USING (school_id=B) で 0 行ヒットになる。
    await withTenantContext(db, ctxB(), (tx) => tx.delete(aiRateLimitWindows), APP);

    const all = await raw`SELECT count FROM ai_rate_limit_windows WHERE school_id = ${fx.schoolA}`;
    expect(all.length).toBe(1);
  });

  it("CHECK 制約: count < 0 は DB が弾く (ルール3 機械強制)", async () => {
    // policy 通過後の制約レベル拒否を見るため raw (BYPASSRLS) で直接 INSERT。
    await expect(
      raw`INSERT INTO ai_rate_limit_windows (school_id, window_start_ms, count)
           VALUES (${fx.schoolA}, 1700000240000, -1)`,
    ).rejects.toThrow();
  });

  it("一意制約: (school_id, window_start_ms) は重複不可 — ON CONFLICT で原子的 increment できる", async () => {
    // ADR-027 の `INSERT ... ON CONFLICT (school_id, window_start_ms) DO UPDATE` 経路の前提を担保する。
    await withTenantContext(
      db,
      ctxA(),
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO ai_rate_limit_windows (school_id, window_start_ms, count)
          VALUES (${fx.schoolA}, 1700000300000, 1)
          ON CONFLICT (school_id, window_start_ms) DO UPDATE SET count = ai_rate_limit_windows.count + 1
        `);
        await tx.execute(sql`
          INSERT INTO ai_rate_limit_windows (school_id, window_start_ms, count)
          VALUES (${fx.schoolA}, 1700000300000, 1)
          ON CONFLICT (school_id, window_start_ms) DO UPDATE SET count = ai_rate_limit_windows.count + 1
        `);
      },
      APP,
    );

    const [row] = await raw<
      { count: number }[]
    >`SELECT count FROM ai_rate_limit_windows WHERE school_id = ${fx.schoolA} AND window_start_ms = 1700000300000`;
    expect(Number(row.count)).toBe(2);
  });
});
