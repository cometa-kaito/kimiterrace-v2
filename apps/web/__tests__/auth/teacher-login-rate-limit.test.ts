import { describe, expect, it } from "vitest";
import {
  LoginFailureLimiter,
  TEACHER_LOGIN_MAX_FAILURES,
} from "@/lib/auth/teacher-login-rate-limit";

/**
 * ADR-032: 教員ログインの失敗回数リミッタ（失敗のみ計上・成功は非計上）。決定的（nowMs 注入）。
 */

const WINDOW = 60_000;

describe("LoginFailureLimiter", () => {
  it("初期状態はブロックしない", () => {
    const lim = new LoginFailureLimiter(3, WINDOW);
    expect(lim.isBlocked("ip", 0)).toBe(false);
  });

  it("失敗が上限に達するとブロックする", () => {
    const lim = new LoginFailureLimiter(3, WINDOW);
    lim.recordFailure("ip", 0);
    lim.recordFailure("ip", 1);
    expect(lim.isBlocked("ip", 2)).toBe(false); // 2 回はまだ
    lim.recordFailure("ip", 3);
    expect(lim.isBlocked("ip", 4)).toBe(true); // 3 回でブロック
  });

  it("ウィンドウ経過でリセットされる", () => {
    const lim = new LoginFailureLimiter(2, WINDOW);
    lim.recordFailure("ip", 0);
    lim.recordFailure("ip", 1);
    expect(lim.isBlocked("ip", 2)).toBe(true);
    // 窓を越えると新ウィンドウ
    expect(lim.isBlocked("ip", WINDOW + 1)).toBe(false);
  });

  it("clear() で失敗カウントを解除（正規ログイン成功時）", () => {
    const lim = new LoginFailureLimiter(2, WINDOW);
    lim.recordFailure("ip", 0);
    lim.recordFailure("ip", 1);
    expect(lim.isBlocked("ip", 2)).toBe(true);
    lim.clear("ip");
    expect(lim.isBlocked("ip", 2)).toBe(false);
  });

  it("IP ごとに独立して数える（学校 NAT 共有でも他 IP に波及しない）", () => {
    const lim = new LoginFailureLimiter(1, WINDOW);
    lim.recordFailure("ip-a", 0);
    expect(lim.isBlocked("ip-a", 0)).toBe(true);
    expect(lim.isBlocked("ip-b", 0)).toBe(false);
  });

  it("maxKeys を超えても Map 上限を保つ（メモリ境界）", () => {
    const lim = new LoginFailureLimiter(5, WINDOW, 10);
    for (let i = 0; i < 100; i++) {
      lim.recordFailure(`ip-${i}`, i); // 各キー別時刻（窓内）
    }
    expect(lim.size()).toBeLessThanOrEqual(10);
  });

  it("既定の上限定数は妥当（>0）", () => {
    expect(TEACHER_LOGIN_MAX_FAILURES).toBeGreaterThan(0);
  });
});
