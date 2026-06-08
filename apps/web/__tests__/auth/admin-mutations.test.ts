import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324, ADR-026): IdP エンフォース seam (deactivate / reactivate) の配線テスト。
 *
 * `getAdminAuth()` を mock し、Admin SDK の `updateUser` / `revokeRefreshTokens` の呼び出しを検証する。
 * **核心**: 無効化は disable **だけでなく** refresh token 失効も呼ぶこと (revoke を省くと既存 cookie が
 * 残存しエンフォースが効かない = #324)。再有効化は revoke しないこと。
 */

const {
  updateUser,
  revokeRefreshTokens,
  setCustomUserClaims,
  createUser,
  generatePasswordResetLink,
  deleteUser,
} = vi.hoisted(() => ({
  updateUser: vi.fn(),
  revokeRefreshTokens: vi.fn(),
  setCustomUserClaims: vi.fn(),
  createUser: vi.fn(),
  generatePasswordResetLink: vi.fn(),
  deleteUser: vi.fn(),
}));
vi.mock("../../lib/auth/adminApp", () => ({
  getAdminAuth: () => ({
    updateUser,
    revokeRefreshTokens,
    setCustomUserClaims,
    createUser,
    generatePasswordResetLink,
    deleteUser,
  }),
}));

// createIdpUser は generatePasswordResetLink の既定リンクを自前 /reset-password に載せ替えるため
// `getRequestOrigin` (→ next/headers) を読む。既定は空 Headers = origin 解決不能で **既定リンクに
// フォールバック** させ、既存アサーション (raw link) を不変に保つ。in-app 載せ替えは専用テストで host を与える。
const { getHeaders } = vi.hoisted(() => ({ getHeaders: vi.fn() }));
vi.mock("next/headers", () => ({ headers: () => getHeaders() }));

import {
  changeIdpUserRole,
  createIdpUser,
  deactivateIdpUser,
  deleteIdpUser,
  isEmailAlreadyExistsError,
  reactivateIdpUser,
} from "../../lib/auth/admin-mutations";

const UID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  updateUser.mockResolvedValue(undefined);
  revokeRefreshTokens.mockResolvedValue(undefined);
  setCustomUserClaims.mockResolvedValue(undefined);
  createUser.mockResolvedValue(undefined);
  generatePasswordResetLink.mockResolvedValue("https://idp/reset-link");
  deleteUser.mockResolvedValue(undefined);
  // 既定: 空 Headers = origin 解決不能 → createIdpUser は既定リンクにフォールバックする。
  getHeaders.mockResolvedValue(new Headers());
  // getRequestOrigin は NEXT_PUBLIC_APP_URL を最優先するため、ヘッダ経路を試すテストでは未設定に固定する。
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deactivateIdpUser (ADR-026 D1)", () => {
  it("IdP を disable し、リフレッシュトークンを失効する (両方)", async () => {
    await deactivateIdpUser(UID);
    expect(updateUser).toHaveBeenCalledWith(UID, { disabled: true });
    expect(revokeRefreshTokens).toHaveBeenCalledWith(UID);
  });

  it("revoke を必ず 1 回呼ぶ — 省くと既存 cookie が残存しエンフォースが効かない (#324 の核心、非空虚)", async () => {
    await deactivateIdpUser(UID);
    expect(revokeRefreshTokens).toHaveBeenCalledTimes(1);
  });

  it("disable を先に成立させてから revoke する (順序)", async () => {
    const order: string[] = [];
    updateUser.mockImplementation(async () => {
      order.push("disable");
    });
    revokeRefreshTokens.mockImplementation(async () => {
      order.push("revoke");
    });
    await deactivateIdpUser(UID);
    expect(order).toEqual(["disable", "revoke"]);
  });

  it("disable が失敗したら revoke しない (IdP 失敗は伝播)", async () => {
    updateUser.mockRejectedValue(new Error("idp down"));
    await expect(deactivateIdpUser(UID)).rejects.toThrow("idp down");
    expect(revokeRefreshTokens).not.toHaveBeenCalled();
  });
});

describe("reactivateIdpUser (ADR-026 D1)", () => {
  it("IdP を enable する", async () => {
    await reactivateIdpUser(UID);
    expect(updateUser).toHaveBeenCalledWith(UID, { disabled: false });
  });

  it("再有効化では revoke しない (利用者が再ログインでトークン取得)", async () => {
    await reactivateIdpUser(UID);
    expect(revokeRefreshTokens).not.toHaveBeenCalled();
  });
});

describe("changeIdpUserRole (ADR-026 D2)", () => {
  it("claims を再付与し ({ role, school_id})、リフレッシュトークンを失効する (両方)", async () => {
    await changeIdpUserRole(UID, "school_admin", SCHOOL_ID);
    expect(setCustomUserClaims).toHaveBeenCalledWith(UID, {
      role: "school_admin",
      school_id: SCHOOL_ID,
    });
    expect(revokeRefreshTokens).toHaveBeenCalledWith(UID);
  });

  it("revoke を必ず 1 回呼ぶ — 降格で旧特権 claim が cookie に残るのを防ぐ (D2 の核心、非空虚)", async () => {
    await changeIdpUserRole(UID, "teacher", SCHOOL_ID);
    expect(revokeRefreshTokens).toHaveBeenCalledTimes(1);
  });

  it("claims 再付与を先に成立させてから revoke する (順序)", async () => {
    const order: string[] = [];
    setCustomUserClaims.mockImplementation(async () => {
      order.push("claims");
    });
    revokeRefreshTokens.mockImplementation(async () => {
      order.push("revoke");
    });
    await changeIdpUserRole(UID, "teacher", SCHOOL_ID);
    expect(order).toEqual(["claims", "revoke"]);
  });

  it("claims 再付与が失敗したら revoke しない (IdP 失敗は伝播)", async () => {
    setCustomUserClaims.mockRejectedValue(new Error("idp down"));
    await expect(changeIdpUserRole(UID, "teacher", SCHOOL_ID)).rejects.toThrow("idp down");
    expect(revokeRefreshTokens).not.toHaveBeenCalled();
  });
});

describe("createIdpUser (#508 発行 seam)", () => {
  it("localId を uid に固定して createUser (== users.id 規約 ADR-003)、password は設定しない", async () => {
    await createIdpUser({
      uid: UID,
      email: "t@example.com",
      displayName: "山田",
      role: "teacher",
      schoolId: SCHOOL_ID,
    });
    expect(createUser).toHaveBeenCalledWith({
      uid: UID,
      email: "t@example.com",
      displayName: "山田",
    });
    // password は渡さない (reset link で利用者が設定)。
    expect(createUser.mock.calls[0]?.[0]).not.toHaveProperty("password");
  });

  it("claims は role / school_id のみ (uid は localId で claim ではない)", async () => {
    await createIdpUser({
      uid: UID,
      email: "t@example.com",
      displayName: "山田",
      role: "teacher",
      schoolId: SCHOOL_ID,
    });
    expect(setCustomUserClaims).toHaveBeenCalledWith(UID, {
      role: "teacher",
      school_id: SCHOOL_ID,
    });
  });

  it("初回パスワード設定リンクを生成して返す", async () => {
    const out = await createIdpUser({
      uid: UID,
      email: "t@example.com",
      displayName: "山田",
      role: "teacher",
      schoolId: SCHOOL_ID,
    });
    expect(generatePasswordResetLink).toHaveBeenCalledWith("t@example.com");
    // origin 解決不能 (空 Headers) のため既定リンクにフォールバックする (発行を壊さない)。
    expect(out).toEqual({ setupLink: "https://idp/reset-link" });
  });

  it("リクエスト origin が解決できれば setupLink を自前 /reset-password に載せ替える (fix #1)", async () => {
    getHeaders.mockResolvedValue(
      new Headers({ "x-forwarded-host": "app.example", "x-forwarded-proto": "https" }),
    );
    generatePasswordResetLink.mockResolvedValue(
      "https://signage.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=OOB123&apiKey=K",
    );
    const out = await createIdpUser({
      uid: UID,
      email: "t@example.com",
      displayName: "山田",
      role: "teacher",
      schoolId: SCHOOL_ID,
    });
    expect(out).toEqual({ setupLink: "https://app.example/reset-password?oobCode=OOB123" });
  });

  it("createUser → claims → link の順 (createUser 失敗で claims/link に到達しない)", async () => {
    const order: string[] = [];
    createUser.mockImplementation(async () => {
      order.push("create");
    });
    setCustomUserClaims.mockImplementation(async () => {
      order.push("claims");
    });
    generatePasswordResetLink.mockImplementation(async () => {
      order.push("link");
      return "https://idp/reset-link";
    });
    await createIdpUser({
      uid: UID,
      email: "t@example.com",
      displayName: "山田",
      role: "teacher",
      schoolId: SCHOOL_ID,
    });
    expect(order).toEqual(["create", "claims", "link"]);
  });

  it("createUser 成功後に claims/link が失敗したら deleteUser で補償して throw (atomic、孤児を残さない)", async () => {
    setCustomUserClaims.mockRejectedValue(new Error("claims failed"));
    await expect(
      createIdpUser({
        uid: UID,
        email: "t@example.com",
        displayName: "山田",
        role: "teacher",
        schoolId: SCHOOL_ID,
      }),
    ).rejects.toThrow("claims failed");
    // createUser 済の claimless 孤児を削除する。
    expect(deleteUser).toHaveBeenCalledWith(UID);
  });

  it("createUser 自体が失敗したら補償削除しない (まだ自分が作っていない既存 user を消さない)", async () => {
    createUser.mockRejectedValue({ code: "auth/email-already-exists" });
    await expect(
      createIdpUser({
        uid: UID,
        email: "t@example.com",
        displayName: "山田",
        role: "teacher",
        schoolId: SCHOOL_ID,
      }),
    ).rejects.toMatchObject({ code: "auth/email-already-exists" });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });
});

describe("deleteIdpUser / isEmailAlreadyExistsError", () => {
  it("deleteIdpUser は Admin SDK deleteUser を呼ぶ (補償削除)", async () => {
    await deleteIdpUser(UID);
    expect(deleteUser).toHaveBeenCalledWith(UID);
  });

  it("isEmailAlreadyExistsError は auth/email-already-exists のみ true", () => {
    expect(isEmailAlreadyExistsError({ code: "auth/email-already-exists" })).toBe(true);
    expect(isEmailAlreadyExistsError({ code: "auth/other" })).toBe(false);
    expect(isEmailAlreadyExistsError(new Error("plain"))).toBe(false);
    expect(isEmailAlreadyExistsError(null)).toBe(false);
    expect(isEmailAlreadyExistsError("string")).toBe(false);
  });
});
