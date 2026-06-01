import { describe, expect, it } from "vitest";
import {
  DistributedRateLimiter,
  createPerSchoolDistributedRateLimiter,
  type RateLimitStore,
} from "../rate-limit-distributed.js";

/**
 * F03 分散レート制限（ADR-027）の単体テスト。
 *
 * 実 PG への結合テストは follow-up PR (#155-B) で `PostgresRateLimitStore` と一緒に追加する。
 * 本ファイルは:
 *   1. ストア境界（`RateLimitStore`）の契約に対する `DistributedRateLimiter` の振る舞いを固定
 *   2. **並行アクセス**で limit を超えないことを fake atomic store で検証（issue #155 受け入れ基準）
 *
 * fake store の原子性: JS のシングルスレッドイベントループ上で同期的に `count < limit` 判定 →
 * インクリメントを行うため、`Promise.all` で同時に投げられた `tryAcquireSlot` は実質シリアル化される。
 * PG 実装は ADR-027 §SQL 契約の `INSERT ... ON CONFLICT DO UPDATE WHERE count < $limit RETURNING`
 * によって同じ原子性を獲得する（DB 側で行レベルロック）。
 */

/**
 * テスト用 fake: ストアの原子性契約を満たす最小実装。
 * 同期的に判定 + インクリメントするため、並列 `Promise.all` でも limit を超えない。
 * 観測用に呼出回数 / 各キー&ウィンドウのカウントを保持する。
 */
class FakeAtomicStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();
  public calls = 0;

  private keyOf(key: string, windowStartMs: number): string {
    return `${key}#${windowStartMs}`;
  }

  // async 宣言だが本体は同期的: ループ 1 tick で判定 → インクリメントが完結し、
  // 他のマイクロタスクは前段の確定後に走る。これで原子性契約を再現する。
  async tryAcquireSlot(key: string, windowStartMs: number, limit: number): Promise<boolean> {
    this.calls += 1;
    const k = this.keyOf(key, windowStartMs);
    const current = this.counts.get(k) ?? 0;
    if (current >= limit) return false;
    this.counts.set(k, current + 1);
    return true;
  }

  // テスト観測用
  countOf(key: string, windowStartMs: number): number {
    return this.counts.get(this.keyOf(key, windowStartMs)) ?? 0;
  }
}

describe("DistributedRateLimiter", () => {
  it("ストア契約に従って limit まで許可し、超過を拒否する", async () => {
    const store = new FakeAtomicStore();
    const rl = new DistributedRateLimiter(store, 3, 1000);
    expect(await rl.tryAcquire("school-a", 0)).toBe(true);
    expect(await rl.tryAcquire("school-a", 100)).toBe(true);
    expect(await rl.tryAcquire("school-a", 200)).toBe(true);
    expect(await rl.tryAcquire("school-a", 300)).toBe(false);
    // 全 4 呼が同一ウィンドウ (windowStart=0) に集約されている
    expect(store.countOf("school-a", 0)).toBe(3);
  });

  it("ウィンドウ跨ぎでカウンタが自動リセットされる（新規 windowStartMs 行）", async () => {
    const store = new FakeAtomicStore();
    const rl = new DistributedRateLimiter(store, 1, 1000);
    expect(await rl.tryAcquire("a", 0)).toBe(true);
    expect(await rl.tryAcquire("a", 999)).toBe(false); // 同ウィンドウ内
    expect(await rl.tryAcquire("a", 1000)).toBe(true); // 次ウィンドウ
    // 別ウィンドウは独立行
    expect(store.countOf("a", 0)).toBe(1);
    expect(store.countOf("a", 1000)).toBe(1);
  });

  it("school 単位で独立してカウントする（key 分離）", async () => {
    const store = new FakeAtomicStore();
    const rl = new DistributedRateLimiter(store, 1, 1000);
    expect(await rl.tryAcquire("school-a", 0)).toBe(true);
    expect(await rl.tryAcquire("school-b", 0)).toBe(true);
    expect(await rl.tryAcquire("school-a", 0)).toBe(false);
    expect(await rl.tryAcquire("school-b", 0)).toBe(false);
  });

  it("F03 既定（60 req / 60 秒 / school）を分散版で満たす", async () => {
    const store = new FakeAtomicStore();
    const rl = createPerSchoolDistributedRateLimiter(store);
    for (let i = 0; i < 60; i += 1) {
      expect(await rl.tryAcquire("s", 0)).toBe(true);
    }
    expect(await rl.tryAcquire("s", 0)).toBe(false);
    expect(await rl.tryAcquire("s", 60_000)).toBe(true);
  });

  // ─── 並行アクセステスト（issue #155 受け入れ基準）─────────────────────────
  // 「複数インスタンス想定で school 単位上限が守られる」を fake atomic store で再現する。
  // 実 PG では同じ振る舞いが ADR-027 §SQL 契約（INSERT ON CONFLICT WHERE count<limit RETURNING）
  // により保証される。follow-up PR (#155-B) で実 PG への結合テストを追加。

  it("並列 200 リクエスト中、limit=60 を 1 も超えずに正確に 60 だけ allow される", async () => {
    const store = new FakeAtomicStore();
    const rl = createPerSchoolDistributedRateLimiter(store);
    // 200 並列 → 60 のみ true を期待
    const results = await Promise.all(
      Array.from({ length: 200 }, () => rl.tryAcquire("school-x", 12_345)),
    );
    const allowed = results.filter((r) => r).length;
    expect(allowed).toBe(60);
    expect(store.calls).toBe(200);
    // 同一ウィンドウ (windowStart = floor(12_345 / 60_000) * 60_000 = 0) に集約
    expect(store.countOf("school-x", 0)).toBe(60);
  });

  it("複数 school への並列リクエストは school 単位で独立に limit が効く", async () => {
    const store = new FakeAtomicStore();
    const rl = new DistributedRateLimiter(store, 3, 1000);
    const tasks: Promise<boolean>[] = [];
    for (let i = 0; i < 10; i += 1) tasks.push(rl.tryAcquire("school-a", 0));
    for (let i = 0; i < 10; i += 1) tasks.push(rl.tryAcquire("school-b", 0));
    const results = await Promise.all(tasks);
    const allowedA = results.slice(0, 10).filter((r) => r).length;
    const allowedB = results.slice(10).filter((r) => r).length;
    expect(allowedA).toBe(3);
    expect(allowedB).toBe(3);
  });

  it("不正な limit / windowMs はコンストラクタで弾く（fail-fast）", () => {
    const store = new FakeAtomicStore();
    expect(() => new DistributedRateLimiter(store, 0, 1000)).toThrow(/limit/);
    expect(() => new DistributedRateLimiter(store, -1, 1000)).toThrow(/limit/);
    expect(() => new DistributedRateLimiter(store, 1.5, 1000)).toThrow(/limit/);
    expect(() => new DistributedRateLimiter(store, 60, 0)).toThrow(/windowMs/);
    expect(() => new DistributedRateLimiter(store, 60, -1)).toThrow(/windowMs/);
  });
});
