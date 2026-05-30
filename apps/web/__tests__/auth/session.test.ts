import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/auth/session.ts の unit テスト (ADR-012: Vitest、firebase-admin は vi.mock)。
 *
 * 検証観点:
 * - 有効 cookie → getCurrentUser が {uid, role, schoolId} を返す
 * - 無効 / 期限切れ cookie → null (deny)
 * - cookie 無し → null
 * - 不正な schoolId (非 UUID) claims → null に倒す (PR #133 Reviewer Low-1)
 * - 不正な role / 非 UUID uid → null
 * - system_admin は schoolId=null を許容
 *
 * 実 Identity Platform / 実 DB は使わない (E2E は #48-O Playwright)。
 */

const VALID_UID = "11111111-1111-4111-8111-111111111111";
const VALID_SCHOOL = "22222222-2222-4222-8222-222222222222";

// firebase-admin の Auth を差し替えるための spy。テストごとに verifySessionCookie の挙動を変える。
const verifySessionCookie = vi.fn();
const createSessionCookie = vi.fn();

vi.mock("../../lib/auth/adminApp", () => ({
  getAdminAuth: () => ({ verifySessionCookie, createSessionCookie }),
  __setAdminAuthForTest: () => {},
}));

// next/headers の cookies() をテストから制御する。
const cookieValue = { current: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "__session" && cookieValue.current !== undefined
        ? { value: cookieValue.current }
        : undefined,
  }),
}));

import { getCurrentUser, verifySessionCookie as verify } from "../../lib/auth/session";

beforeEach(() => {
  verifySessionCookie.mockReset();
  createSessionCookie.mockReset();
  cookieValue.current = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("verifySessionCookie", () => {
  it("有効 cookie + 正常 claims → AuthUser を返す", async () => {
    verifySessionCookie.mockResolvedValue({
      uid: VALID_UID,
      role: "teacher",
      school_id: VALID_SCHOOL,
    });
    await expect(verify("good-cookie")).resolves.toEqual({
      uid: VALID_UID,
      role: "teacher",
      schoolId: VALID_SCHOOL,
    });
  });

  it("system_admin は school_id 無しでも許可 (schoolId=null)", async () => {
    verifySessionCookie.mockResolvedValue({ uid: VALID_UID, role: "system_admin" });
    await expect(verify("good-cookie")).resolves.toEqual({
      uid: VALID_UID,
      role: "system_admin",
      schoolId: null,
    });
  });

  it("無効 / 期限切れ cookie (verify が throw) → null", async () => {
    verifySessionCookie.mockRejectedValue(new Error("auth/session-cookie-expired"));
    await expect(verify("expired")).resolves.toBeNull();
  });

  it("空 cookie → null (Admin SDK を呼ばない)", async () => {
    await expect(verify("")).resolves.toBeNull();
    expect(verifySessionCookie).not.toHaveBeenCalled();
  });

  it("不正な schoolId (非 UUID) claims → null (Low-1)", async () => {
    verifySessionCookie.mockResolvedValue({
      uid: VALID_UID,
      role: "teacher",
      school_id: "not-a-uuid",
    });
    await expect(verify("good-cookie")).resolves.toBeNull();
  });

  it("テナントロールで school_id 欠落 → null", async () => {
    verifySessionCookie.mockResolvedValue({ uid: VALID_UID, role: "teacher" });
    await expect(verify("good-cookie")).resolves.toBeNull();
  });

  it("不正な role → null", async () => {
    verifySessionCookie.mockResolvedValue({
      uid: VALID_UID,
      role: "superadmin",
      school_id: VALID_SCHOOL,
    });
    await expect(verify("good-cookie")).resolves.toBeNull();
  });

  it("非 UUID uid → null", async () => {
    verifySessionCookie.mockResolvedValue({
      uid: "abc",
      role: "teacher",
      school_id: VALID_SCHOOL,
    });
    await expect(verify("good-cookie")).resolves.toBeNull();
  });

  it("system_admin で school_id が付くが非 UUID → null (汚染値を弾く)", async () => {
    verifySessionCookie.mockResolvedValue({
      uid: VALID_UID,
      role: "system_admin",
      school_id: "garbage",
    });
    await expect(verify("good-cookie")).resolves.toBeNull();
  });
});

describe("getCurrentUser", () => {
  it("cookie 無し → null (Admin SDK を呼ばない)", async () => {
    cookieValue.current = undefined;
    await expect(getCurrentUser()).resolves.toBeNull();
    expect(verifySessionCookie).not.toHaveBeenCalled();
  });

  it("cookie 有り + 有効 → AuthUser", async () => {
    cookieValue.current = "good-cookie";
    verifySessionCookie.mockResolvedValue({
      uid: VALID_UID,
      role: "school_admin",
      school_id: VALID_SCHOOL,
    });
    await expect(getCurrentUser()).resolves.toEqual({
      uid: VALID_UID,
      role: "school_admin",
      schoolId: VALID_SCHOOL,
    });
  });

  it("cookie 有り + 無効 (claims 不正) → null", async () => {
    cookieValue.current = "good-cookie";
    verifySessionCookie.mockResolvedValue({
      uid: VALID_UID,
      role: "teacher",
      school_id: "bad",
    });
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});
