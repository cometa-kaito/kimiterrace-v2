import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter, clientKeyFromHeaders } from "../../lib/guide/rate-limit";

/**
 * #234 (#48-M follow-up): guide フィードバック濫用対策の純ロジックを決定的に検証する。
 *
 * `nowMs` を注入して固定ウィンドウの境界・key 独立・リセットを固定し、`clientKeyFromHeaders` の
 * XFF/x-real-ip/フォールバック挙動を固定する。HTTP 配線 (429 応答) は route.test.ts が担保。
 */

describe("FixedWindowRateLimiter", () => {
  it("ウィンドウ内は limit まで許可し、超過は false に倒す", () => {
    const limiter = new FixedWindowRateLimiter(3, 1000);
    expect(limiter.tryAcquire("ip", 0)).toBe(true);
    expect(limiter.tryAcquire("ip", 100)).toBe(true);
    expect(limiter.tryAcquire("ip", 200)).toBe(true);
    // 4 件目 (limit=3 超過) は拒否。
    expect(limiter.tryAcquire("ip", 300)).toBe(false);
    expect(limiter.tryAcquire("ip", 999)).toBe(false);
  });

  it("ウィンドウ経過 (>= windowMs) で新ウィンドウとしてリセットされる", () => {
    const limiter = new FixedWindowRateLimiter(2, 1000);
    expect(limiter.tryAcquire("ip", 0)).toBe(true);
    expect(limiter.tryAcquire("ip", 500)).toBe(true);
    expect(limiter.tryAcquire("ip", 600)).toBe(false); // 同ウィンドウで超過
    // windowStart(0) から windowMs(1000) 経過 → 新ウィンドウ。
    expect(limiter.tryAcquire("ip", 1000)).toBe(true);
    expect(limiter.tryAcquire("ip", 1100)).toBe(true);
    expect(limiter.tryAcquire("ip", 1200)).toBe(false);
  });

  it("key ごとにウィンドウは独立 (片方の枯渇が他方に波及しない)", () => {
    const limiter = new FixedWindowRateLimiter(1, 1000);
    expect(limiter.tryAcquire("a", 0)).toBe(true);
    expect(limiter.tryAcquire("a", 100)).toBe(false); // a は枯渇
    expect(limiter.tryAcquire("b", 100)).toBe(true); // b は無関係に許可
  });

  it("reset() で全 key の状態が破棄される", () => {
    const limiter = new FixedWindowRateLimiter(1, 1000);
    expect(limiter.tryAcquire("ip", 0)).toBe(true);
    expect(limiter.tryAcquire("ip", 100)).toBe(false);
    limiter.reset();
    // リセット後は同ウィンドウ時刻でも再び許可される。
    expect(limiter.tryAcquire("ip", 100)).toBe(true);
  });

  // --- メモリ境界 (公開エンドポイントの DoS 対策): 詐称 key flood で Map を無制限に肥大化させない ---

  it("ユニーク key を maxKeys 超で流し込んでも追跡 key 数は maxKeys 以内に収まる (同一ウィンドウ flood)", () => {
    const maxKeys = 5;
    const limiter = new FixedWindowRateLimiter(1, 1000, maxKeys);
    // 同一ウィンドウ時刻 (nowMs=0) で 100 個のユニーク key を投入 (期限切れ無し = 最古間引きが効く)。
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.tryAcquire(`ip-${i}`, 0)).toBe(true);
    }
    expect(limiter.size()).toBeLessThanOrEqual(maxKeys);
  });

  it("上限到達後の新規 key 追加で期限切れウィンドウが一掃される", () => {
    const maxKeys = 3;
    const limiter = new FixedWindowRateLimiter(1, 1000, maxKeys);
    // t=0 で上限ぶんの key を埋める。
    expect(limiter.tryAcquire("a", 0)).toBe(true);
    expect(limiter.tryAcquire("b", 0)).toBe(true);
    expect(limiter.tryAcquire("c", 0)).toBe(true);
    expect(limiter.size()).toBe(3);
    // windowMs 経過後に新 key を追加 → 既存 3 件は期限切れで一掃され、サイズは上限内のまま。
    expect(limiter.tryAcquire("d", 2000)).toBe(true);
    expect(limiter.size()).toBeLessThanOrEqual(maxKeys);
    // 一掃された a は新ウィンドウとして再び許可される (期限切れ済のため)。
    expect(limiter.tryAcquire("a", 2000)).toBe(true);
  });

  it("間引きは挙動を緩める方向のみ (既存 key のウィンドウ内 limit 判定は不変)", () => {
    const limiter = new FixedWindowRateLimiter(2, 1000, 10);
    // 通常の limit 判定が eviction 導入後も壊れていないことを確認。
    expect(limiter.tryAcquire("x", 0)).toBe(true);
    expect(limiter.tryAcquire("x", 100)).toBe(true);
    expect(limiter.tryAcquire("x", 200)).toBe(false); // limit=2 超過
  });
});

describe("clientKeyFromHeaders", () => {
  it("x-forwarded-for の左端 (client IP) を trim して採る", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 130.211.0.1" });
    expect(clientKeyFromHeaders(headers)).toBe("203.0.113.7");
  });

  it("XFF 単一値も採る", () => {
    expect(clientKeyFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.9" }))).toBe(
      "198.51.100.9",
    );
  });

  it("XFF 不在なら x-real-ip にフォールバック", () => {
    expect(clientKeyFromHeaders(new Headers({ "x-real-ip": "192.0.2.5" }))).toBe("192.0.2.5");
  });

  it("いずれも無ければ定数 'unknown' に倒す (fail toward limiting)", () => {
    expect(clientKeyFromHeaders(new Headers())).toBe("unknown");
  });

  it("XFF が空文字なら x-real-ip → unknown の順で評価する", () => {
    expect(clientKeyFromHeaders(new Headers({ "x-forwarded-for": "" }))).toBe("unknown");
    expect(
      clientKeyFromHeaders(new Headers({ "x-forwarded-for": "", "x-real-ip": "192.0.2.8" })),
    ).toBe("192.0.2.8");
  });
});
