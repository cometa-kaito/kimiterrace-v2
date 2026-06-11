import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Partner API K1 (`docs/api/partner-api-contract.md` §2) `GET /api/partner/advertisers/{id}/metrics`
 * ルートハンドラの単体テスト。
 *
 * DB は使わず `@kimiterrace/db` の `getAdvertiserMetrics` / `withTenantContext` と `@/lib/db` の `getDb`
 * をモックし、「シークレット検証 → id/ym 検証 → system_admin context で集計 → 契約 §2 形に整形」の配線を
 * 検証する。シークレット検証 (`lib/partner/secret`) と ym パース (`lib/reports/month`) は純粋なので実物を
 * 通す。集計クエリ / RLS の実挙動は packages/db の実 PG テスト (DATABASE_URL 設定時) で担保する。
 */

const getAdvertiserMetrics = vi.fn();
// withTenantContext はモックして「渡された ctx で fn を実行する」だけにする (実 DB 不要)。
// route は getDb() の戻り (モックの {}) を tx として fn に渡してほしいので、第3引数 fn を {} で実行する。
const withTenantContext = vi.fn(
  async (_db: unknown, ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    capturedCtx = ctx;
    return await fn({});
  },
);
let capturedCtx: unknown = null;
vi.mock("@kimiterrace/db", () => ({
  getAdvertiserMetrics: (...args: unknown[]) => getAdvertiserMetrics(...args),
  withTenantContext: (db: unknown, ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    withTenantContext(db, ctx, fn),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const { GET } = await import("../../app/api/partner/advertisers/[id]/metrics/route");

const SECRET = "test-partner-secret";
const ADV = "11111111-1111-4111-8111-111111111111";

const SAMPLE_METRICS = {
  advertiserId: ADV,
  companyName: "アクメ社",
  totals: { impressions: 1200, taps: 80, asks: 3, dwellSeconds: 4500, presence: 345 },
  contracts: [{ contractId: "c1", status: "active", targetSchoolCount: 5, monthlyFeeJpy: 30000 }],
};

function makeReq(opts: { id?: string; ym?: string; by?: string; key?: string; bearer?: string }): {
  request: Request;
  ctx: { params: Promise<{ id: string }> };
} {
  const id = opts.id ?? ADV;
  const u = new URL(`https://example.com/api/partner/advertisers/${id}/metrics`);
  if (opts.ym !== undefined) u.searchParams.set("ym", opts.ym);
  if (opts.by !== undefined) u.searchParams.set("by", opts.by);
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers["x-partner-key"] = opts.key;
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return {
    request: new Request(u, { method: "GET", headers }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

const call = (opts: Parameters<typeof makeReq>[0]) => {
  const { request, ctx } = makeReq(opts);
  return GET(request, ctx);
};

describe("GET /api/partner/advertisers/[id]/metrics", () => {
  const prevSecret = process.env.PARTNER_API_SECRET;

  beforeEach(() => {
    capturedCtx = null;
    getAdvertiserMetrics.mockReset();
    getAdvertiserMetrics.mockResolvedValue(SAMPLE_METRICS);
    withTenantContext.mockClear();
    process.env.PARTNER_API_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.PARTNER_API_SECRET;
    else process.env.PARTNER_API_SECRET = prevSecret;
  });

  it("シークレット env 未設定 → 401 (fail-closed)、集計未到達", async () => {
    delete process.env.PARTNER_API_SECRET;
    const res = await call({ ym: "2026-05", key: SECRET });
    expect(res.status).toBe(401);
    expect(getAdvertiserMetrics).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、集計未到達", async () => {
    const res = await call({ ym: "2026-05", key: "wrong" });
    expect(res.status).toBe(401);
    expect(getAdvertiserMetrics).not.toHaveBeenCalled();
  });

  it("シークレット欠如 → 401", async () => {
    const res = await call({ ym: "2026-05" });
    expect(res.status).toBe(401);
    expect(getAdvertiserMetrics).not.toHaveBeenCalled();
  });

  it("ym 不正形式 → 422、集計未到達", async () => {
    const res = await call({ ym: "2026-13", key: SECRET });
    expect(res.status).toBe(422);
    expect(getAdvertiserMetrics).not.toHaveBeenCalled();
  });

  it("ym 未指定 → 422 (必須)", async () => {
    const res = await call({ key: SECRET });
    expect(res.status).toBe(422);
    expect(getAdvertiserMetrics).not.toHaveBeenCalled();
  });

  it("advertiserId が UUID でない → 400、集計未到達", async () => {
    const res = await call({ id: "not-a-uuid", ym: "2026-05", key: SECRET });
    expect(res.status).toBe(400);
    expect(getAdvertiserMetrics).not.toHaveBeenCalled();
  });

  it("正常 → 200 で契約 §2 の totals 形 (presence 含む)", async () => {
    const res = await call({ ym: "2026-05", key: SECRET });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      advertiser_id: ADV,
      company_name: "アクメ社",
      period: "2026-05",
      tz: "Asia/Tokyo",
      totals: {
        impressions: 1200,
        taps: 80,
        asks: 3,
        dwell_seconds: 4500,
        presence: 345,
      },
      contracts: [
        { contract_id: "c1", status: "active", target_school_count: 5, monthly_fee_jpy: 30000 },
      ],
      source: "live",
    });
    expect(typeof body.generated_at).toBe("string");
    // by 未指定なので by_school は出さない。
    expect(body.by_school).toBeUndefined();
  });

  it("system_admin context (cross-tenant) で集計し、降格しない", async () => {
    await call({ ym: "2026-05", key: SECRET });
    expect(capturedCtx).toEqual({ userId: null, schoolId: null, role: "system_admin" });
    // 集計には id / year / month / bySchool=false が渡る。
    expect(getAdvertiserMetrics).toHaveBeenCalledWith(
      {},
      { advertiserId: ADV, year: 2026, month: 5, bySchool: false },
    );
  });

  it("Bearer ヘッダでも 200 (Authorization: Bearer <secret>)", async () => {
    const res = await call({ ym: "2026-05", bearer: SECRET });
    expect(res.status).toBe(200);
  });

  it("?by=school で by_school を含めて 200", async () => {
    getAdvertiserMetrics.mockResolvedValue({
      ...SAMPLE_METRICS,
      bySchool: [
        { schoolId: "s1", schoolName: "A 高校", impressions: 700, taps: 40, presence: 200 },
        { schoolId: "s2", schoolName: "B 高校", impressions: 500, taps: 40, presence: 145 },
      ],
    });
    const res = await call({ ym: "2026-05", by: "school", key: SECRET });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(getAdvertiserMetrics).toHaveBeenCalledWith(
      {},
      { advertiserId: ADV, year: 2026, month: 5, bySchool: true },
    );
    expect(body.by_school).toEqual([
      { school_id: "s1", school_name: "A 高校", impressions: 700, taps: 40, presence: 200 },
      { school_id: "s2", school_name: "B 高校", impressions: 500, taps: 40, presence: 145 },
    ]);
  });

  it("広告主が存在しない (集計 null) → 404", async () => {
    getAdvertiserMetrics.mockResolvedValue(null);
    const res = await call({ ym: "2026-05", key: SECRET });
    expect(res.status).toBe(404);
  });

  it("集計が throw → 500 (詳細は返さない)", async () => {
    getAdvertiserMetrics.mockRejectedValue(new Error("transient"));
    const res = await call({ ym: "2026-05", key: SECRET });
    expect(res.status).toBe(500);
  });
});
