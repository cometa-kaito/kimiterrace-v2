import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `createSessionCookieForUid`（**パスワードレス**セッション発行）の unit テスト（ADR-012: Vitest）。
 *
 * staging 限定 dev-login が使う「uid → custom token → idToken → session cookie」フローを固定する:
 * - Admin SDK `createCustomToken(uid)` を呼ぶ
 * - 公開 API キーで REST `accounts:signInWithCustomToken` を叩き idToken を得る（**password 不要**）
 * - 既存 `createSessionCookie(idToken)` 経路に idToken を渡して __session を発行
 * - API キー欠如 / REST 失敗 / idToken 欠落は throw（route が握り潰し 404 化）
 *
 * 実 Identity Platform / 実ネットワークは使わない（firebase-admin / fetch は vi.mock / spy）。
 */

const VALID_UID = "11111111-1111-4111-8111-111111111111";

// firebase-admin Auth の差し替え。custom token 生成と cookie 発行を制御する。
const createCustomToken = vi.fn();
const createSessionCookie = vi.fn();

vi.mock("../../lib/auth/adminApp", () => ({
  getAdminAuth: () => ({ createCustomToken, createSessionCookie }),
}));

import { createSessionCookieForUid } from "../../lib/auth/session";

const ORIGINAL_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const fetchSpy = vi.spyOn(globalThis, "fetch");

beforeEach(() => {
  createCustomToken.mockReset();
  createSessionCookie.mockReset();
  fetchSpy.mockReset();
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "public-non-secret-api-key";
});

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  else process.env.NEXT_PUBLIC_FIREBASE_API_KEY = ORIGINAL_API_KEY;
  vi.clearAllMocks();
});

/** REST `signInWithCustomToken` の成功レスポンスを返す fetch モック。 */
function mockExchangeOk(idToken: string): void {
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ idToken }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("createSessionCookieForUid — パスワードレス発行", () => {
  it("uid から custom token → idToken → session cookie を発行する（password を使わない）", async () => {
    createCustomToken.mockResolvedValue("fake-custom-token");
    mockExchangeOk("fake-id-token");
    createSessionCookie.mockResolvedValue("fake-session-cookie");

    const cookie = await createSessionCookieForUid(VALID_UID, 1000);

    expect(cookie).toBe("fake-session-cookie");
    // custom token は uid のみで生成（claims は IdP アカウント側に設定済み）。
    expect(createCustomToken).toHaveBeenCalledWith(VALID_UID);
    // REST は公開 API キーで signInWithCustomToken を叩き、custom token を token として送る。
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain("accounts:signInWithCustomToken");
    expect(String(url)).toContain("key=public-non-secret-api-key");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      token: "fake-custom-token",
      returnSecureToken: true,
    });
    // 得た idToken を既存 createSessionCookie 経路（Admin SDK）へ（通常ログインと同一の expiresIn 形）。
    expect(createSessionCookie).toHaveBeenCalledWith("fake-id-token", { expiresIn: 1000 });
  });

  it("API キー未設定 → throw（cookie を発行しない）", async () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    createCustomToken.mockResolvedValue("fake-custom-token");
    await expect(createSessionCookieForUid(VALID_UID, 1000)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSessionCookie).not.toHaveBeenCalled();
  });

  it("REST が非 2xx → throw（idToken を得られない）", async () => {
    createCustomToken.mockResolvedValue("fake-custom-token");
    fetchSpy.mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(createSessionCookieForUid(VALID_UID, 1000)).rejects.toThrow();
    expect(createSessionCookie).not.toHaveBeenCalled();
  });

  it("REST 応答に idToken が無い → throw", async () => {
    createCustomToken.mockResolvedValue("fake-custom-token");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(createSessionCookieForUid(VALID_UID, 1000)).rejects.toThrow();
    expect(createSessionCookie).not.toHaveBeenCalled();
  });

  it("custom token 生成失敗（signBlob 権限欠如等）→ throw（REST に進まない）", async () => {
    createCustomToken.mockRejectedValue(new Error("permission denied"));
    await expect(createSessionCookieForUid(VALID_UID, 1000)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createSessionCookie).not.toHaveBeenCalled();
  });
});
