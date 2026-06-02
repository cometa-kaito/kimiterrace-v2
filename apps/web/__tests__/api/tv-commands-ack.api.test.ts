import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/tv/commands/ack/route";
import { TV_POLL_LIMIT, tvPollRateLimiter } from "../../lib/tv/rate-limit";

/**
 * F15 (ADR-022): TV コマンド ack `POST /api/tv/commands/ack` ルートハンドラの単体テスト。
 *
 * DB は使わず `@kimiterrace/db` の `ackTvCommand` と `lib/db` の `getDb` をモックし、
 * 「body 解析 → device_id/command_id 必須 → レート制限 → シークレット検証 → ドメイン呼び出し → 応答」の
 * 配線を検証する。冪等遷移・cross-tenant 解決の実挙動は packages/db 実 PG テストで担保。
 */
const ackTvCommand = vi.fn();
vi.mock("@kimiterrace/db", () => ({
  ackTvCommand: (...args: unknown[]) => ackTvCommand(...args),
}));
vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));

const SECRET = "test-tv-poll-secret";
const DEV = "11111111-1111-4111-8111-111111111111";
const CMD = "99999999-9999-4999-8999-999999999999";

function makeReq(opts: {
  body?: unknown;
  rawBody?: string;
  key?: string;
  headerKey?: string;
}): Request {
  const u = new URL("https://example.com/api/tv/commands/ack");
  if (opts.key !== undefined) u.searchParams.set("key", opts.key);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.headerKey !== undefined) headers["x-tv-key"] = opts.headerKey;
  const body =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return new Request(u, { method: "POST", headers, body });
}

describe("POST /api/tv/commands/ack", () => {
  const prevSecret = process.env.TV_POLL_SECRET;

  beforeEach(() => {
    tvPollRateLimiter.reset();
    ackTvCommand.mockReset();
    ackTvCommand.mockResolvedValue({ status: "acked" });
    process.env.TV_POLL_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.TV_POLL_SECRET;
    else process.env.TV_POLL_SECRET = prevSecret;
  });

  it("壊れた JSON body → 400、解決なし", async () => {
    const res = await POST(makeReq({ rawBody: "{not json", key: SECRET }));
    expect(res.status).toBe(400);
    expect(ackTvCommand).not.toHaveBeenCalled();
  });

  it("device_id / command_id 欠如 → 400、解決なし", async () => {
    const res = await POST(makeReq({ body: { device_id: DEV }, key: SECRET }));
    expect(res.status).toBe(400);
    expect(ackTvCommand).not.toHaveBeenCalled();
  });

  it("シークレット env 未設定 → 401（fail-closed）、解決なし", async () => {
    delete process.env.TV_POLL_SECRET;
    const res = await POST(makeReq({ body: { device_id: DEV, command_id: CMD }, key: SECRET }));
    expect(res.status).toBe(401);
    expect(ackTvCommand).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、解決なし", async () => {
    const res = await POST(makeReq({ body: { device_id: DEV, command_id: CMD }, key: "wrong" }));
    expect(res.status).toBe(401);
    expect(ackTvCommand).not.toHaveBeenCalled();
  });

  it("正鍵（query key）+ 正body → ackTvCommand 呼出 + 200 で結果返却", async () => {
    const res = await POST(makeReq({ body: { device_id: DEV, command_id: CMD }, key: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "acked" });
    expect(ackTvCommand).toHaveBeenCalledTimes(1);
    expect(ackTvCommand.mock.calls[0]?.[1]).toEqual({ commandId: CMD, deviceId: DEV });
  });

  it("正鍵を x-tv-key ヘッダで渡しても 200", async () => {
    const res = await POST(
      makeReq({ body: { device_id: DEV, command_id: CMD }, headerKey: SECRET }),
    );
    expect(res.status).toBe(200);
    expect(ackTvCommand).toHaveBeenCalledTimes(1);
  });

  it("already_acked / not_found も 200 + status で返す（TV のリトライ判断に委ねる）", async () => {
    ackTvCommand.mockResolvedValue({ status: "already_acked" });
    const a = await POST(makeReq({ body: { device_id: DEV, command_id: CMD }, key: SECRET }));
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ status: "already_acked" });

    ackTvCommand.mockResolvedValue({ status: "not_found" });
    const b = await POST(makeReq({ body: { device_id: DEV, command_id: CMD }, key: SECRET }));
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ status: "not_found" });
  });

  it("レート制限超過（同 device_id で 1 分 5 回超）→ 429、解決なし", async () => {
    for (let i = 0; i < TV_POLL_LIMIT; i++) {
      tvPollRateLimiter.tryAcquire(DEV, Date.now());
    }
    const res = await POST(makeReq({ body: { device_id: DEV, command_id: CMD }, key: SECRET }));
    expect(res.status).toBe(429);
    expect(ackTvCommand).not.toHaveBeenCalled();
  });

  it("DB エラー → 500（次のポーリングで再 ack）", async () => {
    ackTvCommand.mockRejectedValue(new Error("transient"));
    const res = await POST(makeReq({ body: { device_id: DEV, command_id: CMD }, key: SECRET }));
    expect(res.status).toBe(500);
  });
});
