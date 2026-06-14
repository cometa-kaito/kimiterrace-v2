import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Partner API K4 (`docs/api/partner-api-contract.md` §3.5) `GET /api/partner/schools/{id}/hierarchy`
 * ルートハンドラの単体テスト。
 *
 * DB は使わず `@kimiterrace/db` の `getSchoolHierarchy` / `withTenantContext` と `@/lib/db` の `getDb`
 * をモックし、「シークレット検証 → id 検証 → system_admin context で取得 → 契約 §3.5 形へ整形（稼働
 * ステータス算出含む）」の配線を検証する。シークレット検証・id 検証・`classifyTvLiveness` は純粋なので実物を
 * 通す（ステータス写像も実挙動で確認）。RLS の実挙動は packages/db の実 PG テストで担保する。
 */

const getSchoolHierarchy = vi.fn();
let capturedCtx: unknown = null;
const withTenantContext = vi.fn(
  async (_db: unknown, ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    capturedCtx = ctx;
    return await fn({});
  },
);
vi.mock("@kimiterrace/db", () => ({
  getSchoolHierarchy: (...args: unknown[]) => getSchoolHierarchy(...args),
  withTenantContext: (db: unknown, ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    withTenantContext(db, ctx, fn),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const { GET } = await import("../../app/api/partner/schools/[id]/hierarchy/route");

const SECRET = "test-partner-secret";
const SCHOOL = "22222222-2222-4222-8222-222222222222";

// last_seen を「2 分前」(online) と null (never) で混在させ、status 写像を実 classifyTvLiveness で確認。
const RECENT = new Date(Date.now() - 2 * 60 * 1000);
const SAMPLE: {
  school: {
    id: string;
    name: string;
    prefecture: string;
    code: string | null;
    hierarchyMode: string;
  };
  monitors: Array<{
    id: string;
    label: string | null;
    gradeName: string | null;
    departmentName: string | null;
    className: string | null;
    lastSeenAt: Date | null;
    alertState: string;
    monitoringEnabled: boolean;
  }>;
} = {
  school: {
    id: SCHOOL,
    name: "岐阜工業高等学校",
    prefecture: "岐阜県",
    code: "21999A",
    hierarchyMode: "department",
  },
  monitors: [
    {
      id: "d1111111-1111-4111-8111-111111111111",
      label: "電子工学科 1年",
      gradeName: "1年",
      departmentName: "電子工学科",
      className: null,
      lastSeenAt: RECENT,
      alertState: "ok",
      monitoringEnabled: true,
    },
    {
      id: "d2222222-2222-4222-8222-222222222222",
      label: "昇降口",
      gradeName: null,
      departmentName: null,
      className: null,
      lastSeenAt: null,
      alertState: "ok",
      monitoringEnabled: true,
    },
  ],
};

function makeReq(opts: { id?: string; key?: string; bearer?: string }): {
  request: Request;
  ctx: { params: Promise<{ id: string }> };
} {
  const id = opts.id ?? SCHOOL;
  const u = new URL(`https://example.com/api/partner/schools/${id}/hierarchy`);
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

describe("GET /api/partner/schools/[id]/hierarchy", () => {
  const prevSecret = process.env.PARTNER_API_SECRET;

  beforeEach(() => {
    capturedCtx = null;
    getSchoolHierarchy.mockReset();
    getSchoolHierarchy.mockResolvedValue(SAMPLE);
    withTenantContext.mockClear();
    process.env.PARTNER_API_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.PARTNER_API_SECRET;
    else process.env.PARTNER_API_SECRET = prevSecret;
  });

  it("シークレット env 未設定 → 401 (fail-closed)、取得未到達", async () => {
    delete process.env.PARTNER_API_SECRET;
    const res = await call({ key: SECRET });
    expect(res.status).toBe(401);
    expect(getSchoolHierarchy).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、取得未到達", async () => {
    const res = await call({ key: "wrong" });
    expect(res.status).toBe(401);
    expect(getSchoolHierarchy).not.toHaveBeenCalled();
  });

  it("シークレット欠如 → 401", async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(getSchoolHierarchy).not.toHaveBeenCalled();
  });

  it("schoolId が UUID でない → 400、取得未到達", async () => {
    const res = await call({ id: "not-a-uuid", key: SECRET });
    expect(res.status).toBe(400);
    expect(getSchoolHierarchy).not.toHaveBeenCalled();
  });

  it("正常 → 200 で契約 §3.5 形（snake_case・status 写像・秘匿値なし）", async () => {
    const res = await call({ key: SECRET });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      school_id: SCHOOL,
      school_name: "岐阜工業高等学校",
      prefecture: "岐阜県",
      code: "21999A",
      hierarchy_mode: "department",
      source: "live",
    });
    expect(typeof body.generated_at).toBe("string");
    expect(body.monitors).toHaveLength(2);
    // 2 分前 → online、null → never（実 classifyTvLiveness 経由）。
    expect(body.monitors[0]).toMatchObject({
      id: "d1111111-1111-4111-8111-111111111111",
      label: "電子工学科 1年",
      grade_name: "1年",
      department_name: "電子工学科",
      class_name: null,
      status: "online",
      monitoring_enabled: true,
      alert_state: "ok",
    });
    expect(typeof body.monitors[0].last_seen_at).toBe("string");
    expect(body.monitors[1]).toMatchObject({
      label: "昇降口",
      status: "never",
      last_seen_at: null,
    });
    // 秘匿値（device_id / MAC / FCM トークン）は契約上返さない。
    expect(JSON.stringify(body)).not.toContain("device_id");
    expect(JSON.stringify(body)).not.toContain("fcm");
  });

  it("system_admin context (cross-tenant) で取得し、降格しない", async () => {
    await call({ key: SECRET });
    expect(capturedCtx).toEqual({ userId: null, schoolId: null, role: "system_admin" });
    expect(getSchoolHierarchy).toHaveBeenCalledWith({}, SCHOOL);
  });

  it("Bearer ヘッダでも 200", async () => {
    const res = await call({ bearer: SECRET });
    expect(res.status).toBe(200);
  });

  it("学校が存在しない (取得 null) → 404", async () => {
    getSchoolHierarchy.mockResolvedValue(null);
    const res = await call({ key: SECRET });
    expect(res.status).toBe(404);
  });

  it("取得が throw → 500 (詳細は返さない)", async () => {
    getSchoolHierarchy.mockRejectedValue(new Error("transient"));
    const res = await call({ key: SECRET });
    expect(res.status).toBe(500);
  });
});
