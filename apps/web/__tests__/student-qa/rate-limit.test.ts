import { describe, expect, it } from "vitest";
import {
  QA_MAX_KEYS,
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

describe("StudentQaRateLimiter — メモリ境界 (#437 Low-4)", () => {
  it("ユニークキーを maxKeys 超で流しても各 Map は maxKeys 以内（同一ウィンドウ flood）", () => {
    const maxKeys = 5;
    const rl = new StudentQaRateLimiter(1, 1000, maxKeys);
    // 同一ウィンドウ（nowMs 固定）で 20 個のユニーク (ml, ck) ペアを投入。両ゲートとも fresh で許可。
    for (let i = 0; i < 20; i++) {
      expect(
        rl.tryAcquire({ magicLinkId: `ml-${i}`, cookieId: `ck-${i}`, nowMs: 100 }).allowed,
      ).toBe(true);
    }
    expect(rl.sizes().magicLink).toBeLessThanOrEqual(maxKeys);
    expect(rl.sizes().cookie).toBeLessThanOrEqual(maxKeys);
  });

  it("新規キー追加時にまず期限切れ窓を一掃する（サイズが maxKeys を超えない）", () => {
    const maxKeys = 3;
    const rl = new StudentQaRateLimiter(1, 1000, maxKeys);
    for (let i = 0; i < maxKeys; i++) {
      rl.tryAcquire({ magicLinkId: `ml-${i}`, cookieId: `ck-${i}`, nowMs: 0 });
    }
    expect(rl.sizes().magicLink).toBe(maxKeys);
    // windowMs(1000) 経過後に新規キー → 期限切れ maxKeys 件が一掃され、サイズは膨らまない。
    rl.tryAcquire({ magicLinkId: "ml-new", cookieId: "ck-new", nowMs: 1000 });
    expect(rl.sizes().magicLink).toBeLessThanOrEqual(maxKeys);
    expect(rl.sizes().cookie).toBeLessThanOrEqual(maxKeys);
  });

  it("有効ウィンドウ内の同一キー連打は Map を増やさない（in-place 更新）", () => {
    const rl = new StudentQaRateLimiter(10, 1000, 5);
    for (let i = 0; i < 8; i++) {
      rl.tryAcquire({ magicLinkId: "ml-1", cookieId: "ck-1", nowMs: i });
    }
    expect(rl.sizes()).toEqual({ magicLink: 1, cookie: 1 });
  });

  it("既定 maxKeys は 50000", () => {
    expect(QA_MAX_KEYS).toBe(50_000);
  });
});
