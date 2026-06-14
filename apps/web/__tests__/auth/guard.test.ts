import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../lib/auth/session";

/**
 * 認可ガード (#48-C) の 401/403 redirect 分岐検証。
 *
 * `redirect` (next/navigation) は本番では NEXT_REDIRECT を throw して以降の処理を止める。
 * ここでは sentinel を throw するモックに差し替え、(a) 正しい URL で呼ばれること、
 * (b) redirect 後にユーザーを返さず処理が中断することを検証する。
 */

// getCurrentUser をテストごとに差し替え可能にする。
const getCurrentUser = vi.fn<() => Promise<AuthUser | null>>();
vi.mock("../../lib/auth/session", () => ({ getCurrentUser: () => getCurrentUser() }));

// redirect は呼ばれた URL を載せて throw (本番の「以降を実行しない」挙動を再現)。
class RedirectError extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

import { isRoleAllowed, requireRole, requireUser } from "../../lib/auth/guard";

const teacher: AuthUser = {
  uid: "11111111-1111-1111-1111-111111111111",
  role: "teacher",
  schoolId: "22222222-2222-2222-2222-222222222222",
};

afterEach(() => {
  getCurrentUser.mockReset();
});

describe("isRoleAllowed", () => {
  it("許可集合に含まれれば true / 含まれなければ false", () => {
    expect(isRoleAllowed("teacher", ["teacher", "school_admin"])).toBe(true);
    expect(isRoleAllowed("student", ["teacher", "school_admin"])).toBe(false);
  });
});

describe("requireUser (401)", () => {
  it("未認証 → /login?next= に redirect (戻り先をエンコードして載せる)", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(requireUser("/app/editor")).rejects.toMatchObject({
      url: "/login?next=%2Fapp%2Feditor",
    });
  });

  it("認証済み → user を返す (redirect しない)", async () => {
    getCurrentUser.mockResolvedValue(teacher);
    await expect(requireUser()).resolves.toEqual(teacher);
  });
});

describe("requireRole (403)", () => {
  it("未認証 → /login (role チェック前に 401 で弾く)", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(requireRole(["system_admin"])).rejects.toMatchObject({
      url: "/login?next=%2Fadmin",
    });
  });

  it("認証済みだが role 不足 → /forbidden に redirect", async () => {
    getCurrentUser.mockResolvedValue(teacher);
    await expect(requireRole(["system_admin"])).rejects.toMatchObject({ url: "/forbidden" });
  });

  it("認証済み + role 許可 → user を返す", async () => {
    getCurrentUser.mockResolvedValue(teacher);
    await expect(requireRole(["teacher", "school_admin"])).resolves.toEqual(teacher);
  });
});
