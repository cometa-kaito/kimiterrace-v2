import { beforeEach, describe, expect, it } from "vitest";
import {
  SIGNAGE_EVENT_LIMIT,
  SIGNAGE_EVENT_WINDOW_MS,
  signageEventRateLimiter,
} from "../../lib/signage/rate-limit";

/**
 * F07 (#464): events 取り込みの per-token レート制限ポリシーを縛る。アルゴリズム実体 (固定ウィンドウ +
 * メモリ境界) は guide/rate-limit.ts の FixedWindowRateLimiter 側でテスト済。ここでは signage 用に
 * 構成した上限値・窓・per-token 隔離が意図どおりであることを `nowMs` 注入で決定的に検証する。
 */

const NOW = 1_000_000;

beforeEach(() => {
  signageEventRateLimiter.reset();
});

describe("signageEventRateLimiter", () => {
  it("構成値: 60 秒窓で 600 件 (正規の単一教室トラフィックを十分上回る寛容な上限)", () => {
    expect(SIGNAGE_EVENT_LIMIT).toBe(600);
    expect(SIGNAGE_EVENT_WINDOW_MS).toBe(60_000);
  });

  it("同一 token は上限ちょうどまで許可し、超過の 1 件を 429 相当 (false) で頭打ちにする", () => {
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      expect(signageEventRateLimiter.tryAcquire("tokenA", NOW)).toBe(true);
    }
    // 上限到達後の同一窓は拒否。
    expect(signageEventRateLimiter.tryAcquire("tokenA", NOW)).toBe(false);
  });

  it("per-token 隔離: ある token の枯渇は別 token の予算を消費しない (NAT 共有 IP 懸念の回避)", () => {
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      signageEventRateLimiter.tryAcquire("tokenA", NOW);
    }
    expect(signageEventRateLimiter.tryAcquire("tokenA", NOW)).toBe(false);
    // 別 token (= 別教室) は独立した窓を持つ。
    expect(signageEventRateLimiter.tryAcquire("tokenB", NOW)).toBe(true);
  });

  it("窓が進むと同一 token の予算が回復する (固定ウィンドウ)", () => {
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      signageEventRateLimiter.tryAcquire("tokenA", NOW);
    }
    expect(signageEventRateLimiter.tryAcquire("tokenA", NOW)).toBe(false);
    // 窓幅を超えて時刻が進めば新しい窓で再び許可。
    expect(signageEventRateLimiter.tryAcquire("tokenA", NOW + SIGNAGE_EVENT_WINDOW_MS)).toBe(true);
  });
});
