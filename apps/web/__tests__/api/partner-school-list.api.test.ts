import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Partner API K5 (`docs/api/partner-api-contract.md` §3.6) `GET /api/partner/schools`
 * ルートハンドラの単体テスト。
 *
 * DB は使わず `@kimiterrace/db` の `listSchools` / `withTenantContext` と `@/lib/db` の `getDb` をモックし、
 * 「シークレット検証 → system_admin context で一覧取得 → 契約 §3.6 形へ整形（秘匿値なし）」の配線を検証する。
 * シークレット検証は純粋なので実物を通す。RLS の実挙動は packages/db の実 PG テストで担保する。
 */

const listSchools = vi.fn();
let capturedCtx: unknown = null;
const withTenantContext = vi.fn(
  async (_db: unknown, ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    capturedCtx = ctx;
    return await fn({});
  },
);
vi.mock("@kimiterrace/db", () => ({
  listSchools: (...args: unknown[]) => listSchools(...args),
  withTenantContext: (db: unknown, ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    withTenantContext(db, ctx, fn),
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const { GET } = await import("../../app/api/partner/schools/route");

const SECRET = "test-partner-secret";

const SAMPLE = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "岐南工業高等学校",
    prefecture: "岐阜県",
    code: "21999A",
    hierarchyMode: "department",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "○○商業高等学校",
    prefecture: "愛知県",
    code: null,
    hierarchyMode: "class",
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
  },
];

function makeReq(opts: { key?: string; bearer?: string }): Request {
  const u = new URL("https://example.com/api/partner/schools");
  const headers: Record<string, string> = {};
  if (opts.key !== undefined) headers["x-partner-key"] = opts.key;
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new Request(u, { method: "GET", headers });
}

const call = (opts: Parameters<typeof makeReq>[0]) => GET(makeReq(opts));

describe("GET /api/partner/schools", () => {
  const prevSecret = process.env.PARTNER_API_SECRET;

  beforeEach(() => {
    capturedCtx = null;
    listSchools.mockReset();
    listSchools.mockResolvedValue(SAMPLE);
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
    expect(listSchools).not.toHaveBeenCalled();
  });

  it("シークレット不一致 → 401、取得未到達", async () => {
    const res = await call({ key: "wrong" });
    expect(res.status).toBe(401);
    expect(listSchools).not.toHaveBeenCalled();
  });

  it("シークレット欠如 → 401", async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(listSchools).not.toHaveBeenCalled();
  });

  it("正常 → 200 で契約 §3.6 形（snake_case・hierarchy_mode 写像・createdAt は出さない）", async () => {
    const res = await call({ key: SECRET });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ source: "live" });
    expect(typeof body.generated_at).toBe("string");
    expect(body.schools).toHaveLength(2);
    expect(body.schools[0]).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      name: "岐南工業高等学校",
      prefecture: "岐阜県",
      code: "21999A",
      hierarchy_mode: "department",
    });
    expect(body.schools[1]).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      name: "○○商業高等学校",
      prefecture: "愛知県",
      code: null,
      hierarchy_mode: "class",
    });
    // 監査列など射影外のフィールドは漏らさない（contract §0 最小射影）。
    expect(JSON.stringify(body)).not.toContain("createdAt");
    expect(JSON.stringify(body)).not.toContain("created_at");
  });

  it("0 件 → 200 で空配列（一覧なので 404 は無い）", async () => {
    listSchools.mockResolvedValue([]);
    const res = await call({ key: SECRET });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schools).toEqual([]);
  });

  it("system_admin context (cross-tenant) で取得し、降格しない", async () => {
    await call({ key: SECRET });
    expect(capturedCtx).toEqual({ userId: null, schoolId: null, role: "system_admin" });
    expect(listSchools).toHaveBeenCalledWith({});
  });

  it("Bearer ヘッダでも 200", async () => {
    const res = await call({ bearer: SECRET });
    expect(res.status).toBe(200);
  });

  it("取得が throw → 500 (詳細は返さない)", async () => {
    listSchools.mockRejectedValue(new Error("transient"));
    const res = await call({ key: SECRET });
    expect(res.status).toBe(500);
  });
});
