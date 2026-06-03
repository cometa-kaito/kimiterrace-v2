import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F05: 発行/一覧/失効 API の HTTP 挙動テスト (ADR-012 Vitest)。
 *
 * 実 DB / 実 Identity Platform は使わず、auth (getCurrentUser) と db ドメイン関数を mock し、
 * **Route Handler の責務** (認可ゲート・ステータスコード・平文トークンの露出範囲) を検証する。
 * RLS の実挙動は packages/db の RLS テスト (実 PG16) が担保する。
 */

const TEACHER = {
  uid: "11111111-1111-4111-8111-111111111111",
  role: "teacher" as const,
  schoolId: "22222222-2222-4222-8222-222222222222",
};
const CLASS_ID = "33333333-3333-4333-8333-333333333333";
const LINK_ID = "44444444-4444-4444-8444-444444444444";

// vi.mock は巻き上げられるため、factory が参照する値は vi.hoisted で先に用意する
// (class 宣言を直接参照すると TDZ エラーになる)。
const {
  getCurrentUser,
  generateToken,
  hashToken,
  MagicLinkClassNotFoundError,
  createClassMagicLink,
  listClassMagicLinks,
  revokeMagicLink,
  extendMagicLink,
} = vi.hoisted(() => {
  class MagicLinkClassNotFoundError extends Error {}
  return {
    getCurrentUser: vi.fn(),
    generateToken: vi.fn(() => "PLAINTOKEN"),
    hashToken: vi.fn(() => "HASHED"),
    MagicLinkClassNotFoundError,
    createClassMagicLink: vi.fn(),
    listClassMagicLinks: vi.fn(),
    revokeMagicLink: vi.fn(),
    extendMagicLink: vi.fn(),
  };
});

vi.mock("../../lib/auth/session", () => ({ getCurrentUser }));
vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));
vi.mock("../../lib/magic-link/token", () => ({ generateToken, hashToken }));
vi.mock("@kimiterrace/db", () => ({
  MagicLinkClassNotFoundError,
  createClassMagicLink,
  listClassMagicLinks,
  revokeMagicLink,
  extendMagicLink,
  // RLS context を張る代わりに、fake tx でコールバックを実行する。
  withTenantContext: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

import { POST as EXTEND } from "../../app/api/magic-links/[id]/extend/route";
import { POST as REVOKE } from "../../app/api/magic-links/[id]/revoke/route";
import { GET, POST } from "../../app/api/magic-links/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://test/api/magic-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getCurrentUser.mockReset();
  createClassMagicLink.mockReset();
  listClassMagicLinks.mockReset();
  revokeMagicLink.mockReset();
  extendMagicLink.mockReset();
  generateToken.mockReturnValue("PLAINTOKEN");
  hashToken.mockReturnValue("HASHED");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/magic-links (発行)", () => {
  it("未認証は 401", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(401);
  });

  it("発行不可ロール (student) は 403", async () => {
    getCurrentUser.mockResolvedValue({ ...TEACHER, role: "student" });
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(403);
    expect(createClassMagicLink).not.toHaveBeenCalled();
  });

  it("不正な classId は 400", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    const res = await POST(jsonRequest({ classId: "nope" }));
    expect(res.status).toBe(400);
  });

  it("成功は 201 + 平文トークンを 1 度だけ返し、DB には hash を渡す", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    createClassMagicLink.mockResolvedValue({
      id: LINK_ID,
      classId: CLASS_ID,
      expiresAt: new Date("2026-04-01T00:00:00.000Z"),
      revokedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({
      id: LINK_ID,
      classId: CLASS_ID,
      token: "PLAINTOKEN",
      path: "/s/PLAINTOKEN",
      expiresAt: "2026-04-01T00:00:00.000Z",
    });
    // DB に渡るのは hash のみ (平文ではない、ルール5)
    expect(createClassMagicLink).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        tokenHash: "HASHED",
        classId: CLASS_ID,
        schoolId: TEACHER.schoolId,
      }),
    );
  });

  it("他校 classId (MagicLinkClassNotFoundError) は 404", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    createClassMagicLink.mockRejectedValue(new MagicLinkClassNotFoundError("x"));
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/magic-links (一覧)", () => {
  it("成功時 token を含まないメタのみ返す", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    listClassMagicLinks.mockResolvedValue([
      {
        id: LINK_ID,
        classId: CLASS_ID,
        tokenHash: "SHOULD_NOT_LEAK",
        expiresAt: new Date("2026-04-01T00:00:00.000Z"),
        revokedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    const res = await GET(new Request(`http://test/api/magic-links?classId=${CLASS_ID}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.links).toHaveLength(1);
    expect(json.links[0]).not.toHaveProperty("token");
    expect(json.links[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(json)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("classId クエリ欠落は 400", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    const res = await GET(new Request("http://test/api/magic-links"));
    expect(res.status).toBe(400);
  });

  it("既定では listClassMagicLinks に includeRevoked=false を渡す", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    listClassMagicLinks.mockResolvedValue([]);
    await GET(new Request(`http://test/api/magic-links?classId=${CLASS_ID}`));
    expect(listClassMagicLinks).toHaveBeenCalledWith({}, CLASS_ID, { includeRevoked: false });
  });

  it("includeRevoked=true で失効済も要求し、revokedAt を返す (失効履歴)", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    listClassMagicLinks.mockResolvedValue([
      {
        id: LINK_ID,
        classId: CLASS_ID,
        expiresAt: new Date("2026-04-01T00:00:00.000Z"),
        revokedAt: new Date("2026-02-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    const res = await GET(
      new Request(`http://test/api/magic-links?classId=${CLASS_ID}&includeRevoked=true`),
    );
    expect(listClassMagicLinks).toHaveBeenCalledWith({}, CLASS_ID, { includeRevoked: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.links[0].revokedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(json.links[0]).not.toHaveProperty("tokenHash");
  });
});

describe("POST /api/magic-links/{id}/revoke (失効)", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("未認証は 401", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await REVOKE(new Request("http://test"), ctx(LINK_ID));
    expect(res.status).toBe(401);
  });

  it("不正な id は 400", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    const res = await REVOKE(new Request("http://test"), ctx("bad"));
    expect(res.status).toBe(400);
  });

  it("存在しない/失効済 (undefined) は 404", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    revokeMagicLink.mockResolvedValue(undefined);
    const res = await REVOKE(new Request("http://test"), ctx(LINK_ID));
    expect(res.status).toBe(404);
  });

  it("成功は 200 + revokedAt", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    revokeMagicLink.mockResolvedValue({
      id: LINK_ID,
      classId: CLASS_ID,
      expiresAt: new Date("2026-04-01T00:00:00.000Z"),
      revokedAt: new Date("2026-02-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await REVOKE(new Request("http://test"), ctx(LINK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: LINK_ID, revokedAt: "2026-02-01T00:00:00.000Z" });
  });
});

describe("POST /api/magic-links/{id}/extend (期限更新)", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  function extendReq(body: unknown): Request {
    return new Request("http://test/api/magic-links/x/extend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("未認証は 401", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await EXTEND(extendReq({ expiresInDays: 30 }), ctx(LINK_ID));
    expect(res.status).toBe(401);
  });

  it("発行不可ロール (student) は 403", async () => {
    getCurrentUser.mockResolvedValue({ ...TEACHER, role: "student" });
    const res = await EXTEND(extendReq({ expiresInDays: 30 }), ctx(LINK_ID));
    expect(res.status).toBe(403);
    expect(extendMagicLink).not.toHaveBeenCalled();
  });

  it("不正な id は 400 (body 読取前にゲート)", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    const res = await EXTEND(extendReq({ expiresInDays: 30 }), ctx("bad"));
    expect(res.status).toBe(400);
    expect(extendMagicLink).not.toHaveBeenCalled();
  });

  it("expiresInDays 欠落は 400 で DB に到達しない", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    const res = await EXTEND(extendReq({}), ctx(LINK_ID));
    expect(res.status).toBe(400);
    expect(extendMagicLink).not.toHaveBeenCalled();
  });

  it("壊れた JSON body は 400 invalid_body", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    const req = new Request("http://test/api/magic-links/x/extend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await EXTEND(req, ctx(LINK_ID));
    expect(res.status).toBe(400);
    expect(extendMagicLink).not.toHaveBeenCalled();
  });

  it("存在しない/失効済 (undefined) は 404", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    extendMagicLink.mockResolvedValue(undefined);
    const res = await EXTEND(extendReq({ expiresInDays: 30 }), ctx(LINK_ID));
    expect(res.status).toBe(404);
  });

  it("成功は 200 + 新しい expiresAt、DB にはサーバ時刻起点の Date を渡す", async () => {
    getCurrentUser.mockResolvedValue(TEACHER);
    extendMagicLink.mockResolvedValue({
      id: LINK_ID,
      classId: CLASS_ID,
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      revokedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await EXTEND(extendReq({ expiresInDays: 30 }), ctx(LINK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: LINK_ID, expiresAt: "2026-09-01T00:00:00.000Z" });
    // DB には id・サーバ時刻から算出した Date・actor uid が渡る (computeExpiresAt の結果)。
    expect(extendMagicLink).toHaveBeenCalledWith({}, LINK_ID, expect.any(Date), TEACHER.uid);
  });
});
