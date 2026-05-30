import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter, createPerSchoolRateLimiter } from "../rate-limit.js";

describe("FixedWindowRateLimiter", () => {
  it("上限まで許可し、超過を拒否する", () => {
    const rl = new FixedWindowRateLimiter(3, 1000);
    expect(rl.tryAcquire("a", 0)).toBe(true);
    expect(rl.tryAcquire("a", 100)).toBe(true);
    expect(rl.tryAcquire("a", 200)).toBe(true);
    expect(rl.tryAcquire("a", 300)).toBe(false);
  });

  it("ウィンドウ経過後にカウンタをリセットする", () => {
    const rl = new FixedWindowRateLimiter(1, 1000);
    expect(rl.tryAcquire("a", 0)).toBe(true);
    expect(rl.tryAcquire("a", 999)).toBe(false);
    expect(rl.tryAcquire("a", 1000)).toBe(true);
  });

  it("キー（school_id）ごとに独立してカウントする", () => {
    const rl = new FixedWindowRateLimiter(1, 1000);
    expect(rl.tryAcquire("school-a", 0)).toBe(true);
    expect(rl.tryAcquire("school-b", 0)).toBe(true);
    expect(rl.tryAcquire("school-a", 0)).toBe(false);
  });

  it("F03 既定は 60 req / 60 秒", () => {
    const rl = createPerSchoolRateLimiter();
    for (let i = 0; i < 60; i += 1) expect(rl.tryAcquire("s", 0)).toBe(true);
    expect(rl.tryAcquire("s", 0)).toBe(false);
    expect(rl.tryAcquire("s", 60_000)).toBe(true);
  });
});
