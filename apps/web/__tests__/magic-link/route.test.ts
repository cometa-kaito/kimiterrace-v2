import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F05: 発行/一覧/失効 API の HTTP 挙動テスト (ADR-012 Vitest)。
 *
 * 実 DB / 実 Identity Platform は使わず、auth (getCurrentUser) と db ドメイン関数を mock し、
 * **Route Handler の責務** (認可ゲート・ステータスコード・平文トークンの露出範囲) を検証する。
 * RLS の実挙動は packages/db の RLS テスト (実 PG16) が担保する。
 */

const SCHOOL_ADMIN = {
  uid: "11111111-1111-4111-8111-111111111111",
  role: "school_admin" as const,
  schoolId: "22222222-2222-4222-8222-222222222222",
};
// system_admin は school に属さない (schoolId=null)。発行は対象クラスから学校を cross-tenant 解決する。
const SYSTEM_ADMIN = { uid: "99999999-9999-4999-8999-999999999999", role: "system_admin" as const };
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
  getVisibleClassSchoolId,
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
    getVisibleClassSchoolId: vi.fn(),
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
  getVisibleClassSchoolId,
  listClassMagicLinks,
  revokeMagicLink,
  extendMagicLink,
  // RLS context を張る代わりに、fake tx でコールバックを実行する。
  withTenantContext: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

import { POST as EXTEND } from "../../app/api/magic-links/[id]/extend/route";
import { POST as REVOKE } from "../../app/api/magic-links/[id]/revoke/route";
import { GET, POST } from "../../app/api/magic-links/route";

const DAY_MS = 24 * 60 * 60 * 1000;
/** createClassMagicLink に渡った expiresAt（Date）を取り出す。 */
function passedExpiresAt(): Date {
  return createClassMagicLink.mock.calls[0]?.[1]?.expiresAt as Date;
}

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
  getVisibleClassSchoolId.mockReset();
  listClassMagicLinks.mockReset();
  revokeMagicLink.mockReset();
  extendMagicLink.mockReset();
  generateToken.mockReturnValue("PLAINTOKEN");
  hashToken.mockReturnValue("HASHED");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("POST /api/magic-links (発行)", () => {
  it("未認証は 401", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(401);
  });

  it("発行不可ロール (student) は 403", async () => {
    getCurrentUser.mockResolvedValue({ ...SCHOOL_ADMIN, role: "student" });
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(403);
    expect(createClassMagicLink).not.toHaveBeenCalled();
  });

  it("teacher は発行不可 (403) — 生徒リンク発行は管理者へ移管 (finding④)", async () => {
    getCurrentUser.mockResolvedValue({ ...SCHOOL_ADMIN, role: "teacher" });
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(403);
    expect(createClassMagicLink).not.toHaveBeenCalled();
  });

  it("system_admin は cross-tenant で発行できる: クラスから学校を解決し actor=null+identityUid で発行", async () => {
    getCurrentUser.mockResolvedValue(SYSTEM_ADMIN);
    // system_admin は schoolId=null。対象クラスから学校を cross-tenant 解決する。
    getVisibleClassSchoolId.mockResolvedValue("55555555-5555-4555-8555-555555555555");
    createClassMagicLink.mockResolvedValue({
      id: LINK_ID,
      classId: CLASS_ID,
      expiresAt: new Date("2027-04-01T00:00:00.000Z"),
      revokedAt: null,
      createdAt: new Date("2026-06-13T00:00:00.000Z"),
    });
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(201);
    expect(getVisibleClassSchoolId).toHaveBeenCalledWith({}, CLASS_ID);
    // 解決した学校 id で発行し、actor は system_admin（userId=null + IdP uid を identityUid）。
    expect(createClassMagicLink).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        schoolId: "55555555-5555-4555-8555-555555555555",
        classId: CLASS_ID,
        tokenHash: "HASHED",
        actor: { userId: null, identityUid: SYSTEM_ADMIN.uid },
      }),
    );
  });

  it("system_admin で対象クラスが不可視 (学校解決 null) は class_not_found (404)", async () => {
    getCurrentUser.mockResolvedValue(SYSTEM_ADMIN);
    getVisibleClassSchoolId.mockResolvedValue(null);
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(404);
    expect(createClassMagicLink).not.toHaveBeenCalled();
  });

  it("school_admin 発行は自校 id を使い学校解決を呼ばない (actor=自分)", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    createClassMagicLink.mockResolvedValue({
      id: LINK_ID,
      classId: CLASS_ID,
      expiresAt: new Date("2027-04-01T00:00:00.000Z"),
      revokedAt: null,
      createdAt: new Date("2026-06-13T00:00:00.000Z"),
    });
    await POST(jsonRequest({ classId: CLASS_ID }));
    // 自校 id があるので cross-tenant 解決は呼ばない（短絡）。
    expect(getVisibleClassSchoolId).not.toHaveBeenCalled();
    expect(createClassMagicLink).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        schoolId: SCHOOL_ADMIN.schoolId,
        actor: { userId: SCHOOL_ADMIN.uid, identityUid: SCHOOL_ADMIN.uid },
      }),
    );
  });

  it("不正な classId は 400", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    const res = await POST(jsonRequest({ classId: "nope" }));
    expect(res.status).toBe(400);
  });

  it("成功は 201 + 平文トークンを 1 度だけ返し、DB には hash を渡す", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
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
      // サイネージ端末用 URL（同一トークンの /signage/ 経路）も返す。
      signagePath: "/signage/PLAINTOKEN",
      expiresAt: "2026-04-01T00:00:00.000Z",
    });
    // DB に渡るのは hash のみ (平文ではない、ルール5)
    expect(createClassMagicLink).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        tokenHash: "HASHED",
        classId: CLASS_ID,
        schoolId: SCHOOL_ADMIN.schoolId,
      }),
    );
  });

  it("ADR-042 D1: expiresInDays 省略時は無期限で発行する (expiresAt=undefined → DB に NULL)", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    createClassMagicLink.mockResolvedValue({
      id: LINK_ID,
      classId: CLASS_ID,
      token: "PLAINTOKEN",
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date("2026-06-13T00:00:00.000Z"),
    });
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(201);
    // 省略時は有限期限を算出せず undefined を渡す → createClassMagicLink が expires_at に NULL を書く。
    expect(passedExpiresAt()).toBeUndefined();
    // ADR-042 D2: 平文 token を DB に渡す (再表示用の列保存)。
    expect(createClassMagicLink).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ token: "PLAINTOKEN" }),
    );
    // レスポンスの expiresAt は無期限 = null。
    const json = await res.json();
    expect(json.expiresAt).toBeNull();
  });

  it("expiresInDays 明示指定はその日数でサーバ時刻起点に算出する", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-13T00:00:00.000Z");
    vi.setSystemTime(now);
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    createClassMagicLink.mockResolvedValue({
      id: LINK_ID,
      classId: CLASS_ID,
      expiresAt: new Date(now.getTime() + 30 * DAY_MS),
      revokedAt: null,
      createdAt: now,
    });
    await POST(jsonRequest({ classId: CLASS_ID, expiresInDays: 30 }));
    expect(passedExpiresAt().toISOString()).toBe(
      new Date(now.getTime() + 30 * DAY_MS).toISOString(),
    );
  });

  it("他校 classId (MagicLinkClassNotFoundError) は 404", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    createClassMagicLink.mockRejectedValue(new MagicLinkClassNotFoundError("x"));
    const res = await POST(jsonRequest({ classId: CLASS_ID }));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/magic-links (一覧)", () => {
  it("ADR-042 D2: 平文 token は再表示のため返すが、token_hash は決して返さない", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    listClassMagicLinks.mockResolvedValue([
      {
        id: LINK_ID,
        classId: CLASS_ID,
        token: "PLAIN_REDISPLAY",
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
    // 平文 token は再表示用に返す (RLS スコープ済の運用者のみ・ADR-042 D2)。
    expect(json.links[0].token).toBe("PLAIN_REDISPLAY");
    // token_hash は依然返さない (resolve 照合用の内部値)。
    expect(json.links[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(json)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("ADR-042 D2: 旧リンク (token=null) は token を null で返す (再表示不可フォールバック)", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    listClassMagicLinks.mockResolvedValue([
      {
        id: LINK_ID,
        classId: CLASS_ID,
        token: null,
        expiresAt: new Date("2026-04-01T00:00:00.000Z"),
        revokedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    const res = await GET(new Request(`http://test/api/magic-links?classId=${CLASS_ID}`));
    const json = await res.json();
    expect(json.links[0].token).toBeNull();
  });

  it("classId クエリ欠落は 400", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    const res = await GET(new Request("http://test/api/magic-links"));
    expect(res.status).toBe(400);
  });

  it("既定では listClassMagicLinks に includeRevoked=false を渡す", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    listClassMagicLinks.mockResolvedValue([]);
    await GET(new Request(`http://test/api/magic-links?classId=${CLASS_ID}`));
    expect(listClassMagicLinks).toHaveBeenCalledWith({}, CLASS_ID, { includeRevoked: false });
  });

  it("includeRevoked=true で失効済も要求し、revokedAt を返す (失効履歴)", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
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
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    const res = await REVOKE(new Request("http://test"), ctx("bad"));
    expect(res.status).toBe(400);
  });

  it("存在しない/失効済 (undefined) は 404", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    revokeMagicLink.mockResolvedValue(undefined);
    const res = await REVOKE(new Request("http://test"), ctx(LINK_ID));
    expect(res.status).toBe(404);
  });

  it("成功は 200 + revokedAt", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
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
    getCurrentUser.mockResolvedValue({ ...SCHOOL_ADMIN, role: "student" });
    const res = await EXTEND(extendReq({ expiresInDays: 30 }), ctx(LINK_ID));
    expect(res.status).toBe(403);
    expect(extendMagicLink).not.toHaveBeenCalled();
  });

  it("不正な id は 400 (body 読取前にゲート)", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    const res = await EXTEND(extendReq({ expiresInDays: 30 }), ctx("bad"));
    expect(res.status).toBe(400);
    expect(extendMagicLink).not.toHaveBeenCalled();
  });

  it("expiresInDays 欠落は 400 で DB に到達しない", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    const res = await EXTEND(extendReq({}), ctx(LINK_ID));
    expect(res.status).toBe(400);
    expect(extendMagicLink).not.toHaveBeenCalled();
  });

  it("壊れた JSON body は 400 invalid_body", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
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
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
    extendMagicLink.mockResolvedValue(undefined);
    const res = await EXTEND(extendReq({ expiresInDays: 30 }), ctx(LINK_ID));
    expect(res.status).toBe(404);
  });

  it("成功は 200 + 新しい expiresAt、DB にはサーバ時刻起点の Date を渡す", async () => {
    getCurrentUser.mockResolvedValue(SCHOOL_ADMIN);
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
    expect(extendMagicLink).toHaveBeenCalledWith({}, LINK_ID, expect.any(Date), {
      userId: SCHOOL_ADMIN.uid,
      identityUid: SCHOOL_ADMIN.uid,
    });
  });
});
