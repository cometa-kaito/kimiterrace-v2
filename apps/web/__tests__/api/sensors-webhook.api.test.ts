import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/sensors/switchbot/webhook/route";
import { SENSOR_WEBHOOK_LIMIT, sensorWebhookRateLimiter } from "../../lib/sensors/rate-limit";

/**
 * F13 (#408) SwitchBot Webhook ルートハンドラの単体テスト。
 *
 * DB は使わず `@kimiterrace/db` の `recordPresenceEvent` と `lib/db` の `getDb` をモックし、
 * 「レート制限 → シークレット検証 → payload 検証 → ドメイン呼び出し → ステータス」の配線を検証する。
 * シークレット検証・payload 検証・レート制限は本物を通す。RLS/監査の実挙動は packages/db 実 PG テストで担保。
 */
const recordPresenceEvent = vi.fn();
vi.mock("@kimiterrace/db", () => ({
  recordPresenceEvent: (...args: unknown[]) => recordPresenceEvent(...args),
}));
vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));

const SECRET = "test-webhook-secret";
const VALID_BODY = {
  eventType: "changeReport",
  eventVersion: "1",
  context: {
    deviceMac: "AA:BB:CC:DD:EE:01",
    detectionState: "DETECTED",
    timeOfSample: 1700000000000,
  },
};

function makeReq(body: unknown, opts?: { key?: string; raw?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.key !== undefined) headers["x-webhook-key"] = opts.key;
  return new Request("https://example.com/api/sensors/switchbot/webhook", {
    method: "POST",
    headers,
    body: opts?.raw ?? JSON.stringify(body),
  });
}

describe("POST /api/sensors/switchbot/webhook (#408)", () => {
  const prevSecret = process.env.SWITCHBOT_WEBHOOK_SECRET;

  beforeEach(() => {
    sensorWebhookRateLimiter.reset();
    recordPresenceEvent.mockReset();
    recordPresenceEvent.mockResolvedValue({ status: "recorded", schoolId: "s", eventId: "e" });
    process.env.SWITCHBOT_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.SWITCHBOT_WEBHOOK_SECRET;
    else process.env.SWITCHBOT_WEBHOOK_SECRET = prevSecret;
  });

  it("シークレット env 未設定 → 401（fail-closed）、書込みなし", async () => {
    delete process.env.SWITCHBOT_WEBHOOK_SECRET;
    const res = await POST(makeReq(VALID_BODY, { key: SECRET }));
    expect(res.status).toBe(401);
    expect(recordPresenceEvent).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、書込みなし", async () => {
    const res = await POST(makeReq(VALID_BODY, { key: "wrong" }));
    expect(res.status).toBe(401);
    expect(recordPresenceEvent).not.toHaveBeenCalled();
  });

  it("シークレット欠如 → 401", async () => {
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(401);
    expect(recordPresenceEvent).not.toHaveBeenCalled();
  });

  it("正鍵 + 正常 payload → recordPresenceEvent 呼出 + 200", async () => {
    const res = await POST(makeReq(VALID_BODY, { key: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "recorded" });
    expect(recordPresenceEvent).toHaveBeenCalledTimes(1);
    // 正規化された MAC が渡る。
    expect(recordPresenceEvent.mock.calls[0]?.[1]).toMatchObject({ deviceMac: "AABBCCDDEE01" });
  });

  it("正鍵 + 不正 payload → 200 ignored、書込みなし（再送ストーム回避）", async () => {
    const res = await POST(makeReq({ context: {} }, { key: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored" });
    expect(recordPresenceEvent).not.toHaveBeenCalled();
  });

  it("正鍵 + 不正 JSON → 200 ignored", async () => {
    const res = await POST(makeReq(null, { key: SECRET, raw: "{not json" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored" });
    expect(recordPresenceEvent).not.toHaveBeenCalled();
  });

  it("未登録デバイス → 200 unknown_device", async () => {
    recordPresenceEvent.mockResolvedValue({ status: "unknown_device" });
    const res = await POST(makeReq(VALID_BODY, { key: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unknown_device" });
  });

  it("レート制限超過 → 429（シークレット検証より前）", async () => {
    for (let i = 0; i < SENSOR_WEBHOOK_LIMIT; i++) {
      sensorWebhookRateLimiter.tryAcquire("unknown", Date.now());
    }
    const res = await POST(makeReq(VALID_BODY, { key: SECRET }));
    expect(res.status).toBe(429);
    expect(recordPresenceEvent).not.toHaveBeenCalled();
  });

  it("DB エラー → 500（再送で回復）", async () => {
    recordPresenceEvent.mockRejectedValue(new Error("transient"));
    const res = await POST(makeReq(VALID_BODY, { key: SECRET }));
    expect(res.status).toBe(500);
  });
});
