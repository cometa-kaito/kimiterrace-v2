import { DistributedRateLimiter } from "@kimiterrace/ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "../../src/client.js";
import { CloudSqlRateLimiter } from "../../src/queries/ai-rate-limit.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F03 (#348, ADR-027): CloudSqlRateLimiter の **実 PG 結合テスト**。
 *
 * 受け入れ基準 (#348):
 *   - 「複数接続からの真の並行アクセス (Promise.all 同時発火) で 60 req/60s/school 上限が守られる」
 *     を実証する。FakeAtomicStore (PR #345) が JS シングルスレッドで擬似化していた原子性を、
 *     **PG の行レベルロック + WHERE count < $limit RETURNING** で本物の並行に置き換える。
 *
 * テスト戦略:
 *   - `createDbClient` の pool (max=10) を使い、`withTenantContext` の transaction で
 *     プールから別接続を取得 → Promise.all で同時発火 → 同一 (school_id, window_start) 行に
 *     対する upsert が直列化される。結果は **allow 数 == limit** となる (超過は構造的に発生不可)。
 *   - 「DATABASE_URL があるときだけ」走る (ADR-012)。
 */
describeOrSkip("F03 CloudSqlRateLimiter integration (#348, ADR-027)", () => {
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

  it("(逐次) limit まで allow、超過は deny を返す", async () => {
    const store = new CloudSqlRateLimiter(db, APP);
    const w = 60_000;
    expect(await store.tryAcquireSlot(fx.schoolA, w, 3)).toBe(true);
    expect(await store.tryAcquireSlot(fx.schoolA, w, 3)).toBe(true);
    expect(await store.tryAcquireSlot(fx.schoolA, w, 3)).toBe(true);
    expect(await store.tryAcquireSlot(fx.schoolA, w, 3)).toBe(false);
    expect(await store.tryAcquireSlot(fx.schoolA, w, 3)).toBe(false);

    const [row] = await raw<
      { count: number }[]
    >`SELECT count FROM ai_rate_limit_windows WHERE school_id = ${fx.schoolA} AND window_start_ms = ${w}`;
    expect(Number(row.count)).toBe(3);
  });

  it("ウィンドウ跨ぎで新規行が作られ独立にカウントされる", async () => {
    const store = new CloudSqlRateLimiter(db, APP);
    expect(await store.tryAcquireSlot(fx.schoolA, 60_000, 1)).toBe(true);
    expect(await store.tryAcquireSlot(fx.schoolA, 60_000, 1)).toBe(false);
    expect(await store.tryAcquireSlot(fx.schoolA, 120_000, 1)).toBe(true);

    const rows = await raw<{ window_start_ms: string; count: number }[]>`
      SELECT window_start_ms, count FROM ai_rate_limit_windows
      WHERE school_id = ${fx.schoolA} ORDER BY window_start_ms
    `;
    expect(rows.length).toBe(2);
    expect(Number(rows[0].count)).toBe(1);
    expect(Number(rows[1].count)).toBe(1);
  });

  it("school 単位で独立にカウント (RLS で他 school と物理隔離)", async () => {
    const store = new CloudSqlRateLimiter(db, APP);
    expect(await store.tryAcquireSlot(fx.schoolA, 0, 1)).toBe(true);
    expect(await store.tryAcquireSlot(fx.schoolB, 0, 1)).toBe(true);
    expect(await store.tryAcquireSlot(fx.schoolA, 0, 1)).toBe(false);
    expect(await store.tryAcquireSlot(fx.schoolB, 0, 1)).toBe(false);
  });

  // ─── 受け入れ基準: 真の並行アクセス (跨接続) ─────────────────────────────────
  // FakeAtomicStore は JS のイベントループ単一スレッドで擬似化していた。
  // 本テストは postgres-js の pool (max=10) から別接続を Promise.all で同時に
  // 引き、各接続で `INSERT ... ON CONFLICT DO UPDATE WHERE count < $limit` を
  // 並列発火させる。PG の行レベルロックで直列化され、limit を 1 も超えない。
  it("(跨接続) Promise.all で 200 並列 → 正確に 60 のみ allow (limit 不超過の構造保証)", async () => {
    const store = new CloudSqlRateLimiter(db, APP);
    const limiter = new DistributedRateLimiter(store, 60, 60_000);
    // 全要求を同一ウィンドウ (windowStart = 0) に集約する nowMs を渡す
    const results = await Promise.all(
      Array.from({ length: 200 }, () => limiter.tryAcquire(fx.schoolA, 12_345)),
    );
    const allowed = results.filter((r) => r).length;
    expect(allowed).toBe(60);

    const [row] = await raw<
      { count: number }[]
    >`SELECT count FROM ai_rate_limit_windows WHERE school_id = ${fx.schoolA} AND window_start_ms = 0`;
    expect(Number(row.count)).toBe(60);
  });

  it("(跨接続) 複数 school を並列発火 → school 単位で独立に limit 強制", async () => {
    const store = new CloudSqlRateLimiter(db, APP);
    const limiter = new DistributedRateLimiter(store, 3, 60_000);
    const tasks: Promise<boolean>[] = [];
    for (let i = 0; i < 20; i += 1) tasks.push(limiter.tryAcquire(fx.schoolA, 0));
    for (let i = 0; i < 20; i += 1) tasks.push(limiter.tryAcquire(fx.schoolB, 0));
    const results = await Promise.all(tasks);
    const allowedA = results.slice(0, 20).filter((r) => r).length;
    const allowedB = results.slice(20).filter((r) => r).length;
    expect(allowedA).toBe(3);
    expect(allowedB).toBe(3);
  });
});
