import { describe, expect, it } from "vitest";
import {
  QA_QUESTION_LIMIT,
  QA_QUESTION_WINDOW_MS,
  StudentQaRateLimiter,
} from "../../lib/student-qa/rate-limit";

/**
 * F06 (#42): 二重キー（magic_link / cookie）レートリミットの決定的検証。
 * `nowMs` 注入で固定ウィンドウの境界・ゲート独立・原子的 check-then-commit を固定する。
 */

const ML = "ml-1";
const CK = "ck-1";

describe("StudentQaRateLimiter", () => {
  it("各ゲート limit まで許可し、超過は magic_link ゲートで止める（同一 ml、cookie を変えても）", () => {
    const rl = new StudentQaRateLimiter(3, 1000);
    for (let i = 0; i < 3; i++) {
      // cookie を毎回変えても magic_link 側が 3 で頭打ちになる。
      expect(rl.tryAcquire({ magicLinkId: ML, cookieId: `ck-${i}`, nowMs: i * 10 })).toEqual({
        allowed: true,
      });
    }
    expect(rl.tryAcquire({ magicLinkId: ML, cookieId: "ck-new", nowMs: 40 })).toEqual({
      allowed: false,
      blockedBy: "magic_link",
    });
  });

  it("magic_link を変えても同一 cookie が limit で止まる（cookie ゲート）", () => {
    const rl = new StudentQaRateLimiter(2, 1000);
    expect(rl.tryAcquire({ magicLinkId: "ml-a", cookieId: CK, nowMs: 0 }).allowed).toBe(true);
    expect(rl.tryAcquire({ magicLinkId: "ml-b", cookieId: CK, nowMs: 1 }).allowed).toBe(true);
    expect(rl.tryAcquire({ magicLinkId: "ml-c", cookieId: CK, nowMs: 2 })).toEqual({
      allowed: false,
      blockedBy: "cookie",
    });
  });

  it("拒否時は他ゲートのスロットを消費しない（cross-gate 漏れなし）", () => {
    const rl = new StudentQaRateLimiter(1, 1000);
    // cookie ゲートを使い切る（ml-x / ck-shared）。
    expect(rl.tryAcquire({ magicLinkId: "ml-x", cookieId: "ck-shared", nowMs: 0 }).allowed).toBe(
      true,
    );
    // 別 ml + 使い切った cookie → cookie で拒否。ml-y のスロットは消費されないはず。
    expect(rl.tryAcquire({ magicLinkId: "ml-y", cookieId: "ck-shared", nowMs: 1 })).toEqual({
      allowed: false,
      blockedBy: "cookie",
    });
    // ml-y は未消費なので、新しい cookie となら通る。
    expect(rl.tryAcquire({ magicLinkId: "ml-y", cookieId: "ck-fresh", nowMs: 2 }).allowed).toBe(
      true,
    );
  });

  it("ウィンドウ経過でカウンタがリセットされる", () => {
    const rl = new StudentQaRateLimiter(1, 1000);
    expect(rl.tryAcquire({ magicLinkId: ML, cookieId: CK, nowMs: 0 }).allowed).toBe(true);
    expect(rl.tryAcquire({ magicLinkId: ML, cookieId: CK, nowMs: 500 }).allowed).toBe(false);
    // ウィンドウ幅 1000ms 経過 → 再度許可。
    expect(rl.tryAcquire({ magicLinkId: ML, cookieId: CK, nowMs: 1000 }).allowed).toBe(true);
  });

  it("reset で全状態を破棄する", () => {
    const rl = new StudentQaRateLimiter(1, 1000);
    rl.tryAcquire({ magicLinkId: ML, cookieId: CK, nowMs: 0 });
    rl.reset();
    expect(rl.tryAcquire({ magicLinkId: ML, cookieId: CK, nowMs: 0 }).allowed).toBe(true);
  });

  it("既定値は magic_link/cookie ともに 1 分 10 質問", () => {
    expect(QA_QUESTION_LIMIT).toBe(10);
    expect(QA_QUESTION_WINDOW_MS).toBe(60 * 1000);
    const rl = new StudentQaRateLimiter();
    for (let i = 0; i < QA_QUESTION_LIMIT; i++) {
      expect(rl.tryAcquire({ magicLinkId: ML, cookieId: CK, nowMs: i }).allowed).toBe(true);
    }
    expect(rl.tryAcquire({ magicLinkId: ML, cookieId: CK, nowMs: 10 }).allowed).toBe(false);
  });
});
