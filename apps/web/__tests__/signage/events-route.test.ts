import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F07 (#43, #464): POST /signage/{classToken}/events ハンドラのテスト。recordSignageEvent を mock し、
 * 結果 → ステータス (204/410/400) の写像と、body parse (JSON/beacon・サイズ上限・非オブジェクト)、および
 * per-token レート制限 (#464: 超過で 429・record 非到達) を検証する。レート制限の実体 (固定ウィンドウ) は
 * lib/signage/rate-limit.ts (FixedWindowRateLimiter) 側でテスト済なので、ここは route の写像のみ縛る。
 */

const { recordSignageEvent } = vi.hoisted(() => ({ recordSignageEvent: vi.fn() }));
vi.mock("@/lib/signage/event-ingest", () => ({ recordSignageEvent }));

import { POST } from "../../app/(signage)/signage/[classToken]/events/route";
import { signageEventRateLimiter } from "../../lib/signage/rate-limit";

const TOKEN = "THETOKEN";
const ctx = (classToken: string) => ({ params: Promise.resolve({ classToken }) });

function post(body: string): Request {
  return new Request(`http://test/signage/${TOKEN}/events`, { method: "POST", body });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // singleton limiter の窓状態をテスト間で持ち越さない (同一 token キーの累積を防ぐ)。
  signageEventRateLimiter.reset();
});

describe("POST /signage/{classToken}/events", () => {
  it("成功は 204 No Content + no-store、classToken と body を渡す", async () => {
    recordSignageEvent.mockResolvedValue({ ok: true });
    const res = await POST(post(JSON.stringify({ type: "view", slotIndex: 1 })), ctx(TOKEN));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(recordSignageEvent).toHaveBeenCalledWith(TOKEN, { type: "view", slotIndex: 1 });
  });

  it("token 無効 (reason=gone) は 410", async () => {
    recordSignageEvent.mockResolvedValue({ ok: false, reason: "gone" });
    const res = await POST(post(JSON.stringify({ type: "view" })), ctx(TOKEN));
    expect(res.status).toBe(410);
  });

  it("入力不正 (reason=invalid) は 400", async () => {
    recordSignageEvent.mockResolvedValue({ ok: false, reason: "invalid" });
    const res = await POST(post(JSON.stringify({ type: "dwell" })), ctx(TOKEN));
    expect(res.status).toBe(400);
  });

  it("非 JSON body は 400 (解決/記録に到達しない)", async () => {
    const res = await POST(post("not json"), ctx(TOKEN));
    expect(res.status).toBe(400);
    expect(recordSignageEvent).not.toHaveBeenCalled();
  });

  it("配列/非オブジェクト JSON は 400", async () => {
    const res = await POST(post(JSON.stringify([1, 2, 3])), ctx(TOKEN));
    expect(res.status).toBe(400);
    expect(recordSignageEvent).not.toHaveBeenCalled();
  });

  it("body サイズ上限超過は 413 (Content-Length 早期検査で DB に到達しない)", async () => {
    // 大きな body は Content-Length (>2KB) で読込前に 413、不在/詐称時も読込後のバイト長検査で 413。
    const big = JSON.stringify({ type: "view", clientId: "x".repeat(3000) });
    const res = await POST(post(big), ctx(TOKEN));
    expect(res.status).toBe(413);
    expect(recordSignageEvent).not.toHaveBeenCalled();
  });

  it("per-token レート上限超過は 429 + Retry-After、record/body parse に到達しない (#464)", async () => {
    // limiter が枯渇した状況を spy で再現 (固定ウィンドウの実体は rate-limit.ts でテスト済)。
    vi.spyOn(signageEventRateLimiter, "tryAcquire").mockReturnValueOnce(false);
    const res = await POST(post(JSON.stringify({ type: "view" })), ctx(TOKEN));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // 最先頭で弾くので記録層には到達しない。
    expect(recordSignageEvent).not.toHaveBeenCalled();
  });

  it("レート上限内なら従来どおり record に委譲する (limiter が正常系を塞がない)", async () => {
    recordSignageEvent.mockResolvedValue({ ok: true });
    const res = await POST(post(JSON.stringify({ type: "view" })), ctx(TOKEN));
    expect(res.status).toBe(204);
    expect(recordSignageEvent).toHaveBeenCalledTimes(1);
  });
});
