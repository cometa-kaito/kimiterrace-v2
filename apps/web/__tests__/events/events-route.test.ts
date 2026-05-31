import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #43 F07: `POST /signage/{classToken}/events` の HTTP 挙動テスト。
 *
 * 実 DB は使わず ingest (トークン解決 + RLS INSERT) を mock し、**Route Handler の責務**
 * (レート制限 → body parse → バリデーション → ステータス分岐) を pin する。RLS の実挙動
 * (events tenant_isolation の WITH CHECK / withTenantContext) は packages/db の RLS テスト
 * (実 PG16、tenant-isolation.test.ts で events 検証済) が担保する。
 */

const { ingestSignageEvents } = vi.hoisted(() => ({ ingestSignageEvents: vi.fn() }));
vi.mock("@/lib/events/signage-events", () => ({ ingestSignageEvents }));

import { POST } from "../../app/(signage)/signage/[classToken]/events/route";
import { SIGNAGE_EVENTS_LIMIT, signageEventsRateLimiter } from "../../lib/events/rate-limit";

const TOKEN = "class_token_abc123";

function ctx(classToken = TOKEN) {
  return { params: Promise.resolve({ classToken }) };
}

function jsonReq(body: unknown): Request {
  return new Request(`http://test/signage/${TOKEN}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  ingestSignageEvents.mockReset();
  ingestSignageEvents.mockResolvedValue({ inserted: 1 });
  signageEventsRateLimiter.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /signage/{classToken}/events", () => {
  it("有効バッチ → 202 + inserted、ingest に classToken と検証済みイベントを渡す", async () => {
    ingestSignageEvents.mockResolvedValue({ inserted: 2 });
    const res = await POST(jsonReq({ events: [{ type: "view" }, { type: "tap" }] }), ctx());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, inserted: 2 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(ingestSignageEvents).toHaveBeenCalledWith(TOKEN, [
      { type: "view", contentId: null, occurredAt: null, payload: {} },
      { type: "tap", contentId: null, occurredAt: null, payload: {} },
    ]);
  });

  it("無効トークン (ingest が null) → 410 Gone", async () => {
    ingestSignageEvents.mockResolvedValue(null);
    const res = await POST(jsonReq({ events: [{ type: "view" }] }), ctx());
    expect(res.status).toBe(410);
    expect((await res.json()).ok).toBe(false);
  });

  it("壊れた JSON → 400、ingest を呼ばない", async () => {
    const res = await POST(
      new Request(`http://test/signage/${TOKEN}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(ingestSignageEvents).not.toHaveBeenCalled();
  });

  it("バリデーション失敗 (空 events / 不正 type) → 400、ingest を呼ばない", async () => {
    expect((await POST(jsonReq({ events: [] }), ctx())).status).toBe(400);
    expect((await POST(jsonReq({ events: [{ type: "ask" }] }), ctx())).status).toBe(400);
    expect(ingestSignageEvents).not.toHaveBeenCalled();
  });

  it("ingest が throw → 500 (詳細を本文に出さない)", async () => {
    ingestSignageEvents.mockRejectedValue(new Error("insert failed: secret detail"));
    const res = await POST(jsonReq({ events: [{ type: "view" }] }), ctx());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
  });

  it("同一トークンが上限超過 → 429 + Retry-After、その回は ingest を呼ばない", async () => {
    const body = { events: [{ type: "view" }] };
    for (let i = 0; i < SIGNAGE_EVENTS_LIMIT; i++) {
      const ok = await POST(jsonReq(body), ctx());
      expect(ok.status).toBe(202);
    }
    expect(ingestSignageEvents).toHaveBeenCalledTimes(SIGNAGE_EVENTS_LIMIT);

    const limited = await POST(jsonReq(body), ctx());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(ingestSignageEvents).toHaveBeenCalledTimes(SIGNAGE_EVENTS_LIMIT); // 増えない
  });

  it("別トークンは独立した上限を持つ (ハッシュ単位)", async () => {
    const body = { events: [{ type: "view" }] };
    for (let i = 0; i < SIGNAGE_EVENTS_LIMIT; i++) {
      await POST(jsonReq(body), ctx("token_A"));
    }
    expect((await POST(jsonReq(body), ctx("token_A"))).status).toBe(429);
    expect((await POST(jsonReq(body), ctx("token_B"))).status).toBe(202);
  });
});
