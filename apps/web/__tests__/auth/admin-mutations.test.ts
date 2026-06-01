import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324, ADR-026): IdP エンフォース seam (deactivate / reactivate) の配線テスト。
 *
 * `getAdminAuth()` を mock し、Admin SDK の `updateUser` / `revokeRefreshTokens` の呼び出しを検証する。
 * **核心**: 無効化は disable **だけでなく** refresh token 失効も呼ぶこと (revoke を省くと既存 cookie が
 * 残存しエンフォースが効かない = #324)。再有効化は revoke しないこと。
 */

const { updateUser, revokeRefreshTokens, setCustomUserClaims } = vi.hoisted(() => ({
  updateUser: vi.fn(),
  revokeRefreshTokens: vi.fn(),
  setCustomUserClaims: vi.fn(),
}));
vi.mock("../../lib/auth/adminApp", () => ({
  getAdminAuth: () => ({ updateUser, revokeRefreshTokens, setCustomUserClaims }),
}));

import {
  changeIdpUserRole,
  deactivateIdpUser,
  reactivateIdpUser,
} from "../../lib/auth/admin-mutations";

const UID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  updateUser.mockResolvedValue(undefined);
  revokeRefreshTokens.mockResolvedValue(undefined);
  setCustomUserClaims.mockResolvedValue(undefined);
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
