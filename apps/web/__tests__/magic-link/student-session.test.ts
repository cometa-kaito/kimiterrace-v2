import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F05: resolveStudentSession の unit テスト。cookie の token を毎回再解決し、失効を即時反映。
 */

const RESOLVED = {
  id: "44444444-4444-4444-8444-444444444444",
  schoolId: "22222222-2222-4222-8222-222222222222",
  classId: "33333333-3333-4333-8333-333333333333",
};

const { resolveMagicLink, hashToken } = vi.hoisted(() => ({
  resolveMagicLink: vi.fn(),
  hashToken: vi.fn((t: string) => `HASH(${t})`),
}));

const cookieValue = { current: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "__student_session" && cookieValue.current !== undefined
        ? { value: cookieValue.current }
        : undefined,
  }),
}));
vi.mock("@kimiterrace/db", () => ({ resolveMagicLink }));
vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));
vi.mock("../../lib/magic-link/token", () => ({ hashToken }));

import { resolveStudentSession } from "../../lib/magic-link/student-session";

beforeEach(() => {
  resolveMagicLink.mockReset();
  hashToken.mockImplementation((t: string) => `HASH(${t})`);
  cookieValue.current = undefined;
});
afterEach(() => vi.clearAllMocks());

describe("resolveStudentSession", () => {
  it("cookie 無しなら null (DB を引かない)", async () => {
    expect(await resolveStudentSession()).toBeNull();
    expect(resolveMagicLink).not.toHaveBeenCalled();
  });

  it("cookie の token を hash して resolve し、有効なら結果を返す", async () => {
    cookieValue.current = "THETOKEN";
    resolveMagicLink.mockResolvedValue(RESOLVED);
    expect(await resolveStudentSession()).toEqual(RESOLVED);
    expect(resolveMagicLink).toHaveBeenCalledWith(expect.anything(), "HASH(THETOKEN)");
  });

  it("失効済 (resolve null) なら null を返す (即時失効)", async () => {
    cookieValue.current = "THETOKEN";
    resolveMagicLink.mockResolvedValue(null);
    expect(await resolveStudentSession()).toBeNull();
  });
});
