import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/tv/config/route";
import { TV_POLL_LIMIT, tvPollRateLimiter } from "../../lib/tv/rate-limit";

/**
 * F15/F16 (ADR-022) TV ポーリング `GET /api/tv/config` ルートハンドラの単体テスト。
 *
 * DB は使わず `@kimiterrace/db` の `pollTvConfig` と `lib/db` の `getDb` をモックし、
 * 「device_id 必須 → レート制限 → シークレット検証 → ドメイン呼び出し → 応答」の配線を検証する。
 * シークレット検証・レート制限は本物を通す。RLS/解決/last_seen 更新の実挙動は packages/db 実 PG テストで担保。
 */
const pollTvConfig = vi.fn();
vi.mock("@kimiterrace/db", () => ({
  pollTvConfig: (...args: unknown[]) => pollTvConfig(...args),
}));
vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));

const SECRET = "test-tv-poll-secret";
const DEV = "11111111-1111-4111-8111-111111111111";

function makeReq(opts: {
  deviceId?: string;
  key?: string;
  headerKey?: string;
  xff?: string;
}): Request {
  const u = new URL("https://example.com/api/tv/config");
  if (opts.deviceId !== undefined) u.searchParams.set("device_id", opts.deviceId);
  if (opts.key !== undefined) u.searchParams.set("key", opts.key);
  const headers: Record<string, string> = {};
  if (opts.headerKey !== undefined) headers["x-tv-key"] = opts.headerKey;
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return new Request(u, { method: "GET", headers });
}

const OK_RESULT = {
  unknown: false as const,
  version: 3,
  config: {
    deviceLabel: "電子工学科 1年",
    targetMac: "DC:A5:B3:C2:98:A1",
    signageUrl: "https://sig.example/?school=A",
    webhookUrl: null,
    schedule: null,
  },
};

describe("GET /api/tv/config", () => {
  const prevSecret = process.env.TV_POLL_SECRET;

  beforeEach(() => {
    tvPollRateLimiter.reset();
    pollTvConfig.mockReset();
    pollTvConfig.mockResolvedValue(OK_RESULT);
    process.env.TV_POLL_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.TV_POLL_SECRET;
    else process.env.TV_POLL_SECRET = prevSecret;
  });

  it("device_id 欠如 → 400、解決なし", async () => {
    const res = await GET(makeReq({ key: SECRET }));
    expect(res.status).toBe(400);
    expect(pollTvConfig).not.toHaveBeenCalled();
  });

  it("シークレット env 未設定 → 401（fail-closed）、解決なし", async () => {
    delete process.env.TV_POLL_SECRET;
    const res = await GET(makeReq({ deviceId: DEV, key: SECRET }));
    expect(res.status).toBe(401);
    expect(pollTvConfig).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、解決なし", async () => {
    const res = await GET(makeReq({ deviceId: DEV, key: "wrong" }));
    expect(res.status).toBe(401);
    expect(pollTvConfig).not.toHaveBeenCalled();
  });

  it("シークレット欠如 → 401", async () => {
    const res = await GET(makeReq({ deviceId: DEV }));
    expect(res.status).toBe(401);
    expect(pollTvConfig).not.toHaveBeenCalled();
  });

  it("正鍵（query key）+ device_id → pollTvConfig 呼出 + 200 で config 返却", async () => {
    const res = await GET(makeReq({ deviceId: DEV, key: SECRET, xff: "203.0.113.5" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK_RESULT);
    expect(pollTvConfig).toHaveBeenCalledTimes(1);
    // device_id と XFF 由来 IP が渡る。
    expect(pollTvConfig.mock.calls[0]?.[1]).toMatchObject({
      deviceId: DEV,
      lastKnownIp: "203.0.113.5",
    });
  });

  it("正鍵を x-tv-key ヘッダで渡しても 200", async () => {
    const res = await GET(makeReq({ deviceId: DEV, headerKey: SECRET }));
    expect(res.status).toBe(200);
    expect(pollTvConfig).toHaveBeenCalledTimes(1);
  });

  it("XFF 無し → lastKnownIp は null", async () => {
    await GET(makeReq({ deviceId: DEV, key: SECRET }));
    expect(pollTvConfig.mock.calls[0]?.[1]).toMatchObject({ lastKnownIp: null });
  });

  it("未登録 device_id → 200 + unknown:true（pollTvConfig が unknown を返す）", async () => {
    pollTvConfig.mockResolvedValue({ unknown: true, version: 0 });
    const res = await GET(makeReq({ deviceId: DEV, key: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unknown: true, version: 0 });
  });

  it("レート制限超過（同 device_id で 1 分 5 回超）→ 429、解決なし", async () => {
    for (let i = 0; i < TV_POLL_LIMIT; i++) {
      tvPollRateLimiter.tryAcquire(DEV, Date.now());
    }
    const res = await GET(makeReq({ deviceId: DEV, key: SECRET }));
    expect(res.status).toBe(429);
    expect(pollTvConfig).not.toHaveBeenCalled();
  });

  it("別 device_id はレート制限を共有しない（device 単位）", async () => {
    for (let i = 0; i < TV_POLL_LIMIT; i++) {
      tvPollRateLimiter.tryAcquire(DEV, Date.now());
    }
    // 別 device は独立カウントで 200 になる。
    const res = await GET(makeReq({ deviceId: "other-device", key: SECRET }));
    expect(res.status).toBe(200);
  });

  it("DB エラー → 500（次のポーリングで回復）", async () => {
    pollTvConfig.mockRejectedValue(new Error("transient"));
    const res = await GET(makeReq({ deviceId: DEV, key: SECRET }));
    expect(res.status).toBe(500);
  });
});
