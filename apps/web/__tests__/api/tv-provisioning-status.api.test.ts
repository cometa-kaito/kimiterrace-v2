import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/tv/provisioning/[jobId]/status/route";
import { PROVISION_AGENT_LIMIT, provisionAgentRateLimiter } from "../../lib/tv/rate-limit";

/**
 * C方式 TV プロビジョニング `POST /api/tv/provisioning/[jobId]/status` ルートハンドラの単体テスト。
 *
 * DB は使わず `@kimiterrace/db` の `reportProvisioningStatus`（+ status 値域チェック用 enum）と
 * `lib/db` の `getDb` をモックし、「レート制限 → 専用シークレット検証 → agentId 必須 / status 値域 →
 * 報告 → 応答（updated:200 / not_found:404）」の配線を検証する。報告の実挙動は packages/db 実 PG で担保。
 */
// vi.mock はファイル先頭へホイストされるため、factory が**値として**参照するシンボルは vi.hoisted で
// 先に初期化する（素の top-level const を factory 内で参照すると TDZ:
// "Cannot access 'tvProvisioningStatus' before initialization" でスイートが load 失敗する）。
const { reportProvisioningStatus, tvProvisioningStatus } = vi.hoisted(() => ({
  reportProvisioningStatus: vi.fn(),
  // status 値域チェックの単一ソース（route が tvProvisioningStatus.enumValues を参照）。実 enum と同値域。
  tvProvisioningStatus: {
    enumValues: [
      "pending",
      "claimed",
      "preflight",
      "awaiting_physical",
      "provisioning",
      "succeeded",
      "failed",
      "canceled",
    ] as const,
  },
}));
vi.mock("@kimiterrace/db", () => ({
  reportProvisioningStatus: (...args: unknown[]) => reportProvisioningStatus(...args),
  tvProvisioningStatus,
}));
vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));

const SECRET = "test-provision-agent-secret";
const AGENT = "agent-lan-laptop-01";
const JOB = "11111111-1111-4111-8111-111111111111";

function makeReq(opts: { key?: string; body?: unknown; bad?: boolean; xff?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key !== undefined) headers["x-provision-agent-key"] = opts.key;
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return new Request(`https://example.com/api/tv/provisioning/${JOB}/status`, {
    method: "POST",
    headers,
    body: opts.bad ? "{not-json" : JSON.stringify(opts.body ?? {}),
  });
}

const ctx = (jobId = JOB) => ({ params: Promise.resolve({ jobId }) });

describe("POST /api/tv/provisioning/[jobId]/status", () => {
  const prevSecret = process.env.PROVISION_AGENT_SECRET;

  beforeEach(() => {
    provisionAgentRateLimiter.reset();
    reportProvisioningStatus.mockReset();
    reportProvisioningStatus.mockResolvedValue({ status: "updated" });
    process.env.PROVISION_AGENT_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.PROVISION_AGENT_SECRET;
    else process.env.PROVISION_AGENT_SECRET = prevSecret;
  });

  it("シークレット env 未設定 → 401（fail-closed）、報告なし", async () => {
    delete process.env.PROVISION_AGENT_SECRET;
    const res = await POST(makeReq({ key: SECRET, body: { agentId: AGENT } }), ctx());
    expect(res.status).toBe(401);
    expect(reportProvisioningStatus).not.toHaveBeenCalled();
  });

  it("シークレット欠如 → 401、報告なし", async () => {
    const res = await POST(makeReq({ body: { agentId: AGENT } }), ctx());
    expect(res.status).toBe(401);
    expect(reportProvisioningStatus).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、報告なし", async () => {
    const res = await POST(makeReq({ key: "wrong", body: { agentId: AGENT } }), ctx());
    expect(res.status).toBe(401);
    expect(reportProvisioningStatus).not.toHaveBeenCalled();
  });

  it("agentId 欠如 → 400、報告なし", async () => {
    const res = await POST(makeReq({ key: SECRET, body: { status: "provisioning" } }), ctx());
    expect(res.status).toBe(400);
    expect(reportProvisioningStatus).not.toHaveBeenCalled();
  });

  it("不正 JSON body → 400", async () => {
    const res = await POST(makeReq({ key: SECRET, bad: true }), ctx());
    expect(res.status).toBe(400);
    expect(reportProvisioningStatus).not.toHaveBeenCalled();
  });

  it("未知 status → 400、報告なし", async () => {
    const res = await POST(
      makeReq({ key: SECRET, body: { agentId: AGENT, status: "bogus" } }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(reportProvisioningStatus).not.toHaveBeenCalled();
  });

  it("status 省略でも報告は通る（任意フィールド）→ updated:200", async () => {
    const res = await POST(
      makeReq({ key: SECRET, body: { agentId: AGENT, currentStep: "preflight" } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // jobId（route param）と agentId が報告に渡る。
    expect(reportProvisioningStatus.mock.calls[0]?.[1]).toMatchObject({
      jobId: JOB,
      agentId: AGENT,
      currentStep: "preflight",
    });
  });

  it("正鍵 + 有効 status + step → updated:200（step / status が報告に渡る）", async () => {
    const step = { name: "install", status: "ok", detail: { pkg: "tvbridge" } };
    const res = await POST(
      makeReq({ key: SECRET, body: { agentId: AGENT, status: "provisioning", step } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(reportProvisioningStatus).toHaveBeenCalledTimes(1);
    expect(reportProvisioningStatus.mock.calls[0]?.[1]).toMatchObject({
      jobId: JOB,
      agentId: AGENT,
      status: "provisioning",
      step,
    });
  });

  it("一致行なし → not_found:404", async () => {
    reportProvisioningStatus.mockResolvedValue({ status: "not_found" });
    const res = await POST(
      makeReq({ key: SECRET, body: { agentId: AGENT, status: "succeeded" } }),
      ctx(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("レート制限超過（同 IP で 1 分 30 回超）→ 429、報告なし", async () => {
    for (let i = 0; i < PROVISION_AGENT_LIMIT; i++) {
      provisionAgentRateLimiter.tryAcquire("unknown", Date.now());
    }
    const res = await POST(makeReq({ key: SECRET, body: { agentId: AGENT } }), ctx());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(reportProvisioningStatus).not.toHaveBeenCalled();
  });

  it("DB エラー → 500", async () => {
    reportProvisioningStatus.mockRejectedValue(new Error("transient"));
    const res = await POST(
      makeReq({ key: SECRET, body: { agentId: AGENT, status: "provisioning" } }),
      ctx(),
    );
    expect(res.status).toBe(500);
  });
});
