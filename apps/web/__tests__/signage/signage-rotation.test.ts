import {
  DEFAULT_AD_MS,
  MAX_AD_MS,
  MIN_AD_MS,
  POLL_BASE_MS,
  POLL_JITTER_RATIO,
  clampAdDurationMs,
  clampIndex,
  jitteredPollMs,
  jstDateString,
  nextIndex,
} from "@/lib/signage/rotation";
import { describe, expect, it } from "vitest";

/**
 * #48-E2 サイネージ再生制御の純粋ロジック。DB/DOM 非依存でローテーション・ポーリング間隔・
 * JST 日付の境界を固定する (RLS 込みの取得は signage-display.ts の integration テスト領域)。
 */
describe("clampAdDurationMs", () => {
  it("正常な秒数を ms に変換する", () => {
    expect(clampAdDurationMs(10)).toBe(10_000);
    expect(clampAdDurationMs(30)).toBe(30_000);
  });

  it("不正値 (0/負/非有限) は既定値に丸める", () => {
    expect(clampAdDurationMs(0)).toBe(DEFAULT_AD_MS);
    expect(clampAdDurationMs(-5)).toBe(DEFAULT_AD_MS);
    expect(clampAdDurationMs(Number.NaN)).toBe(DEFAULT_AD_MS);
    expect(clampAdDurationMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_AD_MS);
  });

  it("範囲外は下限・上限へクランプする (広告が一瞬/固着するのを防ぐ)", () => {
    expect(clampAdDurationMs(1)).toBe(MIN_AD_MS); // 1s → 3s 下限
    expect(clampAdDurationMs(9999)).toBe(MAX_AD_MS); // 上限 120s
  });
});

describe("nextIndex / clampIndex", () => {
  it("循環する", () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBe(0);
  });

  it("空 (length<=0) は 0 を返す", () => {
    expect(nextIndex(0, 0)).toBe(0);
    expect(clampIndex(5, 0)).toBe(0);
  });

  it("件数減で範囲外を指したら丸める (ポーリングで広告が減った場合)", () => {
    expect(clampIndex(4, 3)).toBe(1);
    expect(clampIndex(2, 3)).toBe(2);
  });
});

describe("jitteredPollMs", () => {
  it("rnd=0.5 ならジッタ 0 で基準値", () => {
    expect(jitteredPollMs(POLL_BASE_MS, POLL_JITTER_RATIO, () => 0.5)).toBe(POLL_BASE_MS);
  });

  it("rnd 端で ±ratio の範囲に収まる (50 台の位相分散)", () => {
    const lo = jitteredPollMs(POLL_BASE_MS, POLL_JITTER_RATIO, () => 0);
    const hi = jitteredPollMs(POLL_BASE_MS, POLL_JITTER_RATIO, () => 1);
    expect(lo).toBe(POLL_BASE_MS - POLL_JITTER_RATIO * POLL_BASE_MS); // 8s
    expect(hi).toBe(POLL_BASE_MS + POLL_JITTER_RATIO * POLL_BASE_MS); // 12s
    expect(lo).toBeGreaterThanOrEqual(MIN_AD_MS);
  });
});

describe("jstDateString", () => {
  it("UTC 深夜でも JST の日付 (翌日) を返す", () => {
    // 2026-05-31T15:30:00Z = 2026-06-01T00:30 JST
    expect(jstDateString(new Date("2026-05-31T15:30:00Z"))).toBe("2026-06-01");
  });

  it("JST 日中は同日", () => {
    // 2026-05-31T03:00:00Z = 2026-05-31T12:00 JST
    expect(jstDateString(new Date("2026-05-31T03:00:00Z"))).toBe("2026-05-31");
  });
});
