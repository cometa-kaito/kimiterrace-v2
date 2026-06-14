import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#47, ADR-031): enforceMfaGate の検証。next/navigation の redirect と IdP 件数 seam を mock。
 *
 * 核心:
 * - **既定 OFF (env 未設定 / MFA_ENFORCEMENT≠on)**: IdP も叩かず redirect もしない (既存挙動の不変・回帰なし)。
 * - **ON 時**: 未登録 (0 件) の teacher 以上のみ enrollment へ redirect。登録済み / 対象外は通す。
 * - **ループ防止**: 既に enrollment ページ配下なら redirect しない。
 * - **fail-safe**: IdP 読取失敗時は通す (可用性優先)。
 */

vi.mock("../../lib/auth/mfa-admin", () => ({ getEnrolledMfaFactorCount: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    // 本物の redirect は throw して制御を奪う。それを模す (呼出後の到達不能を検証可能に)。
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

import { redirect } from "next/navigation";
import { getEnrolledMfaFactorCount } from "../../lib/auth/mfa-admin";
import { enforceMfaGate } from "../../lib/mfa/enforce-gate";

const factorCountMock = vi.mocked(getEnrolledMfaFactorCount);
const redirectMock = vi.mocked(redirect);

const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const teacher = {
  uid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  role: "teacher" as const,
  schoolId: SCHOOL_ID,
};

const ORIGINAL_ENV = process.env.MFA_ENFORCEMENT;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MFA_ENFORCEMENT;
  factorCountMock.mockResolvedValue(0);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.MFA_ENFORCEMENT;
  } else {
    process.env.MFA_ENFORCEMENT = ORIGINAL_ENV;
  }
});

describe("enforceMfaGate (既定 OFF = 挙動不変)", () => {
  it("env 未設定: IdP を叩かず redirect もしない (回帰なし)", async () => {
    await enforceMfaGate(teacher, "/app/dashboard");
    expect(factorCountMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("MFA_ENFORCEMENT=off: 同様に IdP も redirect もしない", async () => {
    process.env.MFA_ENFORCEMENT = "off";
    await enforceMfaGate(teacher, "/app/dashboard");
    expect(factorCountMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("enforceMfaGate (ON 時)", () => {
  beforeEach(() => {
    process.env.MFA_ENFORCEMENT = "on";
  });

  it("未登録 (0 件) の teacher は enrollment へ redirect (throw)", async () => {
    factorCountMock.mockResolvedValue(0);
    await expect(enforceMfaGate(teacher, "/app/dashboard")).rejects.toThrow(
      "NEXT_REDIRECT:/app/account/mfa",
    );
    expect(redirectMock).toHaveBeenCalledWith("/app/account/mfa");
  });

  it("登録済み (1 件) は redirect しない (通す)", async () => {
    factorCountMock.mockResolvedValue(1);
    await enforceMfaGate(teacher, "/app/dashboard");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("ループ防止: 既に enrollment ページ配下なら IdP も叩かず redirect しない", async () => {
    await enforceMfaGate(teacher, "/app/account/mfa");
    expect(factorCountMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("fail-safe: IdP 読取が失敗したら redirect せず通す (可用性優先、最終防衛線は IdP challenge)", async () => {
    factorCountMock.mockRejectedValue(new Error("idp down"));
    await enforceMfaGate(teacher, "/app/dashboard");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("currentPath undefined でも未登録なら redirect する (ヘッダ取得失敗時も強制は効く)", async () => {
    factorCountMock.mockResolvedValue(0);
    await expect(enforceMfaGate(teacher, undefined)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirectMock).toHaveBeenCalledWith("/app/account/mfa");
  });
});
