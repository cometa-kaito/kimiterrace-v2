import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/tv/provisioning/claim/route";
import { PROVISION_AGENT_LIMIT, provisionAgentRateLimiter } from "../../lib/tv/rate-limit";

/**
 * C方式 TV プロビジョニング `POST /api/tv/provisioning/claim` ルートハンドラの単体テスト。
 *
 * DB は使わず `@kimiterrace/db` の `claimNextProvisioningJob` と `lib/db` の `getDb` をモックし、
 * 「レート制限 → 専用シークレット検証 → agentId 必須 → claim 呼び出し → 応答」の配線を検証する。
 * シークレット検証・レート制限は本物を通す。claim の実挙動（SKIP LOCKED 等）は packages/db 実 PG で担保。
 */
const claimNextProvisioningJob = vi.fn();
vi.mock("@kimiterrace/db", () => ({
  claimNextProvisioningJob: (...args: unknown[]) => claimNextProvisioningJob(...args),
}));
vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));

const SECRET = "test-provision-agent-secret";
const AGENT = "agent-lan-laptop-01";

function makeReq(opts: { key?: string; body?: unknown; bad?: boolean; xff?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key !== undefined) headers["x-provision-agent-key"] = opts.key;
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return new Request("https://example.com/api/tv/provisioning/claim", {
    method: "POST",
    headers,
    body: opts.bad ? "{not-json" : JSON.stringify(opts.body ?? {}),
  });
}

const CLAIMED = {
  id: "11111111-1111-4111-8111-111111111111",
  schoolId: "22222222-2222-4222-8222-222222222222",
  classId: null,
  deviceId: null,
  targetIp: "192.168.1.50",
  signageUrl: "https://sig.example/?school=A",
  scheduleJson: null,
  targetMac: "DC:A5:B3:C2:98:A1",
  status: "claimed" as const,
};

describe("POST /api/tv/provisioning/claim", () => {
  const prevSecret = process.env.PROVISION_AGENT_SECRET;

  beforeEach(() => {
    provisionAgentRateLimiter.reset();
    claimNextProvisioningJob.mockReset();
    claimNextProvisioningJob.mockResolvedValue(CLAIMED);
    process.env.PROVISION_AGENT_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.PROVISION_AGENT_SECRET;
    else process.env.PROVISION_AGENT_SECRET = prevSecret;
  });

  it("シークレット env 未設定 → 401（fail-closed）、claim なし", async () => {
    delete process.env.PROVISION_AGENT_SECRET;
    const res = await POST(makeReq({ key: SECRET, body: { agentId: AGENT } }));
    expect(res.status).toBe(401);
    expect(claimNextProvisioningJob).not.toHaveBeenCalled();
  });

  it("シークレット欠如 → 401、claim なし", async () => {
    const res = await POST(makeReq({ body: { agentId: AGENT } }));
    expect(res.status).toBe(401);
    expect(claimNextProvisioningJob).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、claim なし", async () => {
    const res = await POST(makeReq({ key: "wrong", body: { agentId: AGENT } }));
    expect(res.status).toBe(401);
    expect(claimNextProvisioningJob).not.toHaveBeenCalled();
  });

  it("agentId 欠如 → 400、claim なし", async () => {
    const res = await POST(makeReq({ key: SECRET, body: {} }));
    expect(res.status).toBe(400);
    expect(claimNextProvisioningJob).not.toHaveBeenCalled();
  });

  it("agentId 空文字 → 400", async () => {
    const res = await POST(makeReq({ key: SECRET, body: { agentId: "" } }));
    expect(res.status).toBe(400);
    expect(claimNextProvisioningJob).not.toHaveBeenCalled();
  });

  it("不正 JSON body → 400", async () => {
    const res = await POST(makeReq({ key: SECRET, bad: true }));
    expect(res.status).toBe(400);
    expect(claimNextProvisioningJob).not.toHaveBeenCalled();
  });

  it("正鍵 + agentId、ジョブあり → 200 {job}（claim に agentId が渡る・鍵は返さない）", async () => {
    const res = await POST(makeReq({ key: SECRET, body: { agentId: AGENT } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: CLAIMED });
    expect(claimNextProvisioningJob).toHaveBeenCalledTimes(1);
    expect(claimNextProvisioningJob.mock.calls[0]?.[1]).toBe(AGENT);
  });

  it("正鍵 + agentId、ジョブなし → 200 {job:null}", async () => {
    claimNextProvisioningJob.mockResolvedValue(null);
    const res = await POST(makeReq({ key: SECRET, body: { agentId: AGENT } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: null });
  });

  it("レート制限超過（同 IP で 1 分 30 回超）→ 429、claim なし", async () => {
    // default makeReq は XFF 無し → clientKeyFromHeaders は "unknown"。同 key を上限まで消費。
    for (let i = 0; i < PROVISION_AGENT_LIMIT; i++) {
      provisionAgentRateLimiter.tryAcquire("unknown", Date.now());
    }
    const res = await POST(makeReq({ key: SECRET, body: { agentId: AGENT } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(claimNextProvisioningJob).not.toHaveBeenCalled();
  });

  it("別 IP はレート制限を共有しない（client IP 単位）", async () => {
    for (let i = 0; i < PROVISION_AGENT_LIMIT; i++) {
      provisionAgentRateLimiter.tryAcquire("unknown", Date.now());
    }
    // 別 IP（XFF 指定）は独立カウントで 200。
    const res = await POST(makeReq({ key: SECRET, body: { agentId: AGENT }, xff: "203.0.113.9" }));
    expect(res.status).toBe(200);
  });

  it("DB エラー → 500", async () => {
    claimNextProvisioningJob.mockRejectedValue(new Error("transient"));
    const res = await POST(makeReq({ key: SECRET, body: { agentId: AGENT } }));
    expect(res.status).toBe(500);
  });
});
