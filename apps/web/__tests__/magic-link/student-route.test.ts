import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F05: 生徒匿名アクセス route `GET /s/{token}` の挙動テスト。
 * resolve / 記録 / token ハッシュ化を mock し、410 / redirect+cookie / ベストエフォートを検証。
 */

const RESOLVED = {
  id: "44444444-4444-4444-8444-444444444444",
  schoolId: "22222222-2222-4222-8222-222222222222",
  classId: "33333333-3333-4333-8333-333333333333",
};

const { resolveMagicLink, recordStudentAccess, hashToken } = vi.hoisted(() => ({
  resolveMagicLink: vi.fn(),
  recordStudentAccess: vi.fn(),
  hashToken: vi.fn((t: string) => `HASH(${t})`),
}));

vi.mock("@kimiterrace/db", () => ({ resolveMagicLink }));
vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));
vi.mock("../../lib/magic-link/student-access", () => ({ recordStudentAccess }));
vi.mock("../../lib/magic-link/token", () => ({ hashToken }));

import { GET } from "../../app/s/[token]/route";

function req(): Request {
  return new Request("http://test/s/THETOKEN", {
    headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "UA/1.0" },
  });
}
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  resolveMagicLink.mockReset();
  recordStudentAccess.mockReset();
  hashToken.mockImplementation((t: string) => `HASH(${t})`);
});
afterEach(() => vi.clearAllMocks());

describe("GET /s/{token}", () => {
  it("失効/期限切れ/不明 (resolve null) は 410 Gone (HTML)", async () => {
    resolveMagicLink.mockResolvedValue(null);
    const res = await GET(req(), ctx("THETOKEN"));
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toContain("text/html");
    // DB へは hash を渡す (平文ではない)
    expect(resolveMagicLink).toHaveBeenCalledWith(expect.anything(), "HASH(THETOKEN)");
  });

  it("有効なら /student に 302 redirect し、token を httpOnly cookie に載せる", async () => {
    resolveMagicLink.mockResolvedValue(RESOLVED);
    recordStudentAccess.mockResolvedValue(undefined);
    const res = await GET(req(), ctx("THETOKEN"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/student");
    const cookie = res.cookies.get("__student_session");
    expect(cookie?.value).toBe("THETOKEN");
    expect(cookie?.httpOnly).toBe(true);
  });

  it("有効時にアクセスを events に記録する (resolved + IP/UA)", async () => {
    resolveMagicLink.mockResolvedValue(RESOLVED);
    recordStudentAccess.mockResolvedValue(undefined);
    await GET(req(), ctx("THETOKEN"));
    expect(recordStudentAccess).toHaveBeenCalledWith(RESOLVED, {
      ip: "203.0.113.7",
      userAgent: "UA/1.0",
    });
  });

  it("記録が失敗してもアクセスは通す (ベストエフォート、302)", async () => {
    resolveMagicLink.mockResolvedValue(RESOLVED);
    recordStudentAccess.mockRejectedValue(new Error("db down"));
    const res = await GET(req(), ctx("THETOKEN"));
    expect(res.status).toBe(302);
  });

  it("空 token は 410", async () => {
    const res = await GET(req(), ctx(""));
    expect(res.status).toBe(410);
    expect(resolveMagicLink).not.toHaveBeenCalled();
  });
});
