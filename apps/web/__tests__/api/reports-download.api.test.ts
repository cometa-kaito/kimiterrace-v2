import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F09 (#430): 月次レポート PDF DL ルートハンドラ (`/api/reports/{id}/download`) の単体テスト。
 *
 * DB / GCS は使わず `@/lib/db` の `withSession`、`@kimiterrace/db` の `getMonthlyReport`、DL 監査
 * (`writeReportDownloadAudit`)、DL ポート (`getReportDownloadPort`) をモックし、ルートの
 * 「認証 → role 境界 (system_admin only) → RLS 解決 → DL 監査 → GCS stream」配線を検証する。
 * RLS / 監査の実挙動は packages/db の RLS テスト + CI 実走 (実 PG) で担保する。
 */

const VALID_ID = "33333333-3333-3333-3333-333333333333";
const SYS_UID = "11111111-1111-1111-1111-111111111111";
const SCHOOL_ID = "22222222-2222-2222-2222-222222222222";

// ---- モック: @/lib/db --------------------------------------------------------
class UnauthenticatedError extends Error {}
class ForbiddenError extends Error {}
type FakeUser = { uid: string; role: string; schoolId: string | null };
let authed = true;
let currentRole = "system_admin";
const withSession = vi.fn(
  async (
    fn: (tx: unknown, user: FakeUser) => Promise<unknown>,
    options?: { allowedRoles?: readonly string[] },
  ) => {
    if (!authed) throw new UnauthenticatedError();
    if (options?.allowedRoles && !options.allowedRoles.includes(currentRole)) {
      throw new ForbiddenError();
    }
    return await fn({}, { uid: SYS_UID, schoolId: null, role: currentRole });
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

// SYSTEM_ADMIN_ROLES (db error 連鎖を避けるため定数だけ差し替え)。
vi.mock("@/lib/system-admin/roles", () => ({ SYSTEM_ADMIN_ROLES: ["system_admin"] as const }));

// ---- モック: @kimiterrace/db getMonthlyReport ------------------------------
const getMonthlyReport = vi.fn();
vi.mock("@kimiterrace/db", () => ({ getMonthlyReport }));

// ---- モック: DL 監査 ---------------------------------------------------------
const writeReportDownloadAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/reports/download-audit", () => ({ writeReportDownloadAudit }));

// ---- モック: DL ポート (GCS) ------------------------------------------------
const fetchObject = vi.fn();
vi.mock("@/lib/reports/download-port", () => ({
  getReportDownloadPort: () => ({ fetch: fetchObject }),
}));

const { GET } = await import("../../app/api/reports/[id]/download/route");

const SAMPLE_REPORT = {
  id: VALID_ID,
  schoolId: SCHOOL_ID,
  schoolName: "テスト高校 A",
  targetYear: 2026,
  targetMonth: 5,
  pdfStoragePath: "reports/2026/05/22222222-2222-2222-2222-222222222222.pdf",
  pdfSizeBytes: 2048,
  generatedAt: new Date("2026-06-01T00:00:00Z"),
};

function pdfStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("%PDF-1.7 fake"));
      controller.close();
    },
  });
}

function req(id = VALID_ID, headers?: Record<string, string>): Request {
  return new Request(`http://localhost/api/reports/${id}/download`, { headers });
}

function ctx(id = VALID_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authed = true;
  currentRole = "system_admin";
  getMonthlyReport.mockResolvedValue(SAMPLE_REPORT);
  fetchObject.mockResolvedValue({
    body: pdfStream(),
    contentType: "application/pdf",
    contentLength: 2048,
  });
  writeReportDownloadAudit.mockResolvedValue(undefined);
});

describe("GET /api/reports/{id}/download", () => {
  it("system_admin は 200 + application/pdf + 添付ヘッダ + no-store", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="monthly-report-2026-05.pdf"',
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Length")).toBe("2048");
    const text = await res.text();
    expect(text).toContain("%PDF-1.7");
  });

  it("DL は audit_log に記録される (誰が・どの校の・どのレポートを、PII 非格納)", async () => {
    await GET(req(VALID_ID, { "x-forwarded-for": "203.0.113.7", "user-agent": "UA/1.0" }), ctx());
    expect(writeReportDownloadAudit).toHaveBeenCalledTimes(1);
    const [, input] = writeReportDownloadAudit.mock.calls.at(0) ?? [];
    expect(input).toMatchObject({
      actor: { uid: SYS_UID, role: "system_admin" },
      reportId: VALID_ID,
      schoolId: SCHOOL_ID,
      targetYear: 2026,
      targetMonth: 5,
      objectPath: SAMPLE_REPORT.pdfStoragePath,
      ip: "203.0.113.7",
      userAgent: "UA/1.0",
    });
  });

  it("監査はレスポンス stream を返す前に成立する (解決 → 監査 → 取得の順)", async () => {
    await GET(req(), ctx());
    // 監査が GCS 取得より先に呼ばれる (持ち出しの否認防止)。
    const auditOrder = writeReportDownloadAudit.mock.invocationCallOrder.at(0) ?? 0;
    const fetchOrder = fetchObject.mock.invocationCallOrder.at(0) ?? 0;
    expect(auditOrder).toBeGreaterThan(0);
    expect(auditOrder).toBeLessThan(fetchOrder);
  });

  it("未認証は 401 (解決・監査・取得未到達)", async () => {
    authed = false;
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    expect(getMonthlyReport).not.toHaveBeenCalled();
    expect(writeReportDownloadAudit).not.toHaveBeenCalled();
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it("teacher は 403 (role gate、監査・取得未到達)", async () => {
    currentRole = "teacher";
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    expect(getMonthlyReport).not.toHaveBeenCalled();
    expect(writeReportDownloadAudit).not.toHaveBeenCalled();
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it("school_admin も 403 (cross-tenant レポートは system_admin 専用)", async () => {
    currentRole = "school_admin";
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    expect(getMonthlyReport).not.toHaveBeenCalled();
  });

  it("不正な id は 400 (UUID 形式でない、解決未到達)", async () => {
    const res = await GET(req("not-a-uuid"), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(getMonthlyReport).not.toHaveBeenCalled();
  });

  it("RLS で不可視 / 不存在のレポートは 404 (監査されない・GCS 未取得)", async () => {
    getMonthlyReport.mockResolvedValue(undefined);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    expect(writeReportDownloadAudit).not.toHaveBeenCalled();
    expect(fetchObject).not.toHaveBeenCalled();
  });

  it("履歴はあるが GCS にオブジェクトが無い場合は 404 (監査は済む)", async () => {
    fetchObject.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    // レポートは解決済みで監査は成立する (アクセス試行の記録は残す)。
    expect(writeReportDownloadAudit).toHaveBeenCalledTimes(1);
  });

  it("Content-Length 不明なら省略する (Content-Length ヘッダ無し)", async () => {
    fetchObject.mockResolvedValue({
      body: pdfStream(),
      contentType: "application/pdf",
      contentLength: undefined,
    });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBeNull();
  });
});
