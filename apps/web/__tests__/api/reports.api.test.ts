import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F09 (#45) 第2スライス: 月次レポート CSV ルートハンドラの単体テスト。
 *
 * DB は使わず `@/lib/db` の `withSession` と `@kimiterrace/db` の集計関数をモックし、ルートの
 * 「認証 → role 境界 → 月解決 → CSV ヘッダ/本文」配線を検証する。CSV シリアライズ (`lib/reports/csv`)
 * と月演算 (`lib/reports/month`) は純粋なので実物を通し、出力本文・ファイル名まで結合で確認する。
 * RLS / 監査の実挙動は packages/db の RLS テスト + CI 実走 (実 PG) で担保する。
 */

// ---- モック: @/lib/db --------------------------------------------------------
class UnauthenticatedError extends Error {}
class ForbiddenError extends Error {}
type FakeUser = { uid: string; role: string; schoolId: string };
const fakeUser = {
  uid: "11111111-1111-1111-1111-111111111111",
  schoolId: "22222222-2222-2222-2222-222222222222",
};
let authed = true;
let currentRole = "teacher";
const withSession = vi.fn(
  async (
    fn: (tx: unknown, user: FakeUser) => Promise<unknown>,
    options?: { allowedRoles?: readonly string[] },
  ) => {
    if (!authed) throw new UnauthenticatedError();
    if (options?.allowedRoles && !options.allowedRoles.includes(currentRole)) {
      throw new ForbiddenError();
    }
    return await fn({}, { ...fakeUser, role: currentRole });
  },
);
vi.mock("@/lib/db", () => ({
  withSession: (
    fn: (tx: unknown, user: FakeUser) => Promise<unknown>,
    options?: { allowedRoles?: readonly string[] },
  ) => withSession(fn, options),
  UnauthenticatedError,
  ForbiddenError,
}));

// publish-core は @kimiterrace/db の error クラス連鎖を引くため、定数だけに差し替える。
vi.mock("@/lib/contents/publish-core", () => ({
  PUBLISHER_ROLES: ["school_admin", "teacher"] as const,
}));

// ---- モック: @kimiterrace/db 集計関数 ---------------------------------------
const getMonthlySchoolSummary = vi.fn();
vi.mock("@kimiterrace/db", () => ({ getMonthlySchoolSummary }));

const { GET } = await import("../../app/api/reports/monthly/route");

const SAMPLE = {
  year: 2026,
  month: 3,
  totals: { view: 10, tap: 2, ask: 1 },
  activeDays: 5,
  ranking: [{ contentId: "c1", title: "お知らせ", views: 8, taps: 2, total: 10 }],
};

function get(ym?: string): Request {
  const url = ym
    ? `http://localhost/api/reports/monthly?ym=${encodeURIComponent(ym)}`
    : "http://localhost/api/reports/monthly";
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  authed = true;
  currentRole = "teacher";
  getMonthlySchoolSummary.mockResolvedValue(SAMPLE);
});

describe("GET /api/reports/monthly", () => {
  it("teacher は 200 + text/csv ヘッダ + 添付ファイル名", async () => {
    const res = await GET(get("2026-03"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="monthly-report-2026-03.csv"',
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // 本文の集計値配線を確認する。BOM は body に含むが Response.text() が UTF-8 デコードで
  // 先頭 BOM を剥がすため、ここでは内容のみ検証する (BOM 自体は csv.test.ts が担保)。
  it("本文の CSV に集計値が反映される", async () => {
    const res = await GET(get("2026-03"));
    const text = await res.text();
    expect(text).toContain("キミテラス 月次レポート,2026年3月");
    expect(text).toContain("表示 (view),10");
    expect(text).toContain("1,お知らせ,8,2,10");
  });

  it("?ym=YYYY-MM を集計に渡す (過去月)", async () => {
    await GET(get("2026-03"));
    expect(getMonthlySchoolSummary).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ year: 2026, month: 3 }),
    );
  });

  it("不正な ym は現在の JST 暦月へ丸めて 200 (集計は呼ばれる)", async () => {
    const res = await GET(get("bogus"));
    expect(res.status).toBe(200);
    expect(getMonthlySchoolSummary).toHaveBeenCalledTimes(1);
  });

  it("未来月は要求してもファイル名に反映されない (現在月へ丸め)", async () => {
    const res = await GET(get("2099-12"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).not.toContain("2099-12");
  });

  it("未認証は 401 で集計未到達", async () => {
    authed = false;
    const res = await GET(get("2026-03"));
    expect(res.status).toBe(401);
    expect(getMonthlySchoolSummary).not.toHaveBeenCalled();
  });

  it("非 publisher ロール (student) は 403 で集計未到達", async () => {
    currentRole = "student";
    const res = await GET(get("2026-03"));
    expect(res.status).toBe(403);
    expect(getMonthlySchoolSummary).not.toHaveBeenCalled();
  });

  it("system_admin も 403 (自校スコープのビュー、cross-tenant は別スライス)", async () => {
    currentRole = "system_admin";
    const res = await GET(get("2026-03"));
    expect(res.status).toBe(403);
    expect(getMonthlySchoolSummary).not.toHaveBeenCalled();
  });
});
