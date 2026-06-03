import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#47, ADR-031) — MfaEnrollment の **監査失敗時 UX** (#544 Reviewer Low-2)。
 *
 * 検証する不変条件:
 * - enroll/unenroll は **IdP client SDK で成功している**段で監査を呼ぶ。監査が失敗 (戻り値 `!ok` /
 *   IdP 一時障害等の **throw**) しても、それは登録/解除の失敗ではない。汎用エラー (「コードが正しくない」/
 *   「解除に失敗」) でなく「登録/解除は成功・監査のみ失敗」を表示すること (throw を取り違えない)。
 * - 逆に enroll/unenroll **自体** が失敗したら従来どおり汎用エラーを表示し、監査は呼ばない
 *   (取り違え防止が本物の失敗を握り潰さない = 非空虚)。
 *
 * firebase client SDK (`multiFactor` / `TotpMultiFactorGenerator`) と `getClientAuth`・router・
 * 監査 action を mock する。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/mfa/enrollment-actions", () => ({ recordMfaEnrollmentAudit: vi.fn() }));
vi.mock("firebase/auth", () => ({
  multiFactor: vi.fn(),
  TotpMultiFactorGenerator: {
    generateSecret: vi.fn(),
    assertionForEnrollment: vi.fn(),
  },
}));
vi.mock("../../lib/auth/clientApp", () => ({ getClientAuth: vi.fn() }));

import { TotpMultiFactorGenerator, multiFactor } from "firebase/auth";
import { MfaEnrollment } from "../../app/admin/account/mfa/_components/MfaEnrollment";
import { getClientAuth } from "../../lib/auth/clientApp";
import { recordMfaEnrollmentAudit } from "@/lib/mfa/enrollment-actions";

const auditMock = vi.mocked(recordMfaEnrollmentAudit);
const multiFactorMock = vi.mocked(multiFactor);
const getClientAuthMock = vi.mocked(getClientAuth);
const generateSecretMock = vi.mocked(TotpMultiFactorGenerator.generateSecret);
const assertionMock = vi.mocked(TotpMultiFactorGenerator.assertionForEnrollment);

/**
 * mock の MultiFactorUser を据え、currentUser を truthy にする。`factors` 非空なら登録済みリスト
 * (「解除」ボタン) が出る。enroll/unenroll/getSession は既定で成功する vi.fn を返す。
 */
function mountMultiFactor(factors: Array<{ uid: string; displayName: string }> = []) {
  const mf = {
    enrolledFactors: factors,
    getSession: vi.fn().mockResolvedValue({}),
    enroll: vi.fn().mockResolvedValue(undefined),
    unenroll: vi.fn().mockResolvedValue(undefined),
  };
  multiFactorMock.mockReturnValue(mf as unknown as ReturnType<typeof multiFactor>);
  getClientAuthMock.mockReturnValue({
    currentUser: {},
  } as unknown as ReturnType<typeof getClientAuth>);
  return mf;
}

/** enroll secret を生成済みにして「登録を確定」まで到達し、6 桁コードを入力する。 */
async function startEnrollAndEnterCode(code = "123456") {
  generateSecretMock.mockResolvedValue({
    secretKey: "SETUPKEY1234567",
  } as unknown as Awaited<ReturnType<typeof TotpMultiFactorGenerator.generateSecret>>);
  assertionMock.mockReturnValue(
    {} as unknown as ReturnType<typeof TotpMultiFactorGenerator.assertionForEnrollment>,
  );
  fireEvent.click(screen.getByRole("button", { name: "二要素認証を登録" }));
  fireEvent.change(await screen.findByLabelText(/6 桁コード/), { target: { value: code } });
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue({ ok: true, data: { enrolledFactorCount: 1 } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("MfaEnrollment 監査失敗 UX (#544 Reviewer Low-2)", () => {
  it("enroll 成功後に監査が throw しても『登録は成功・監査のみ失敗』を表示 (登録失敗と取り違えない)", async () => {
    mountMultiFactor([]);
    auditMock.mockRejectedValue(new Error("IdP transient")); // 監査 action が throw
    render(<MfaEnrollment />);

    await startEnrollAndEnterCode();
    fireEvent.click(screen.getByRole("button", { name: "登録を確定" }));

    expect(
      await screen.findByText(/登録は完了しましたが監査記録に失敗しました/),
    ).toBeInTheDocument();
    // 登録失敗の汎用エラーは出ない (throw を enroll 失敗と取り違えない)。
    expect(screen.queryByText(/コードが正しくない/)).not.toBeInTheDocument();
  });

  it("enroll 成功 + 監査が !ok を返した場合も監査失敗を表示 (既存 graceful 経路の回帰)", async () => {
    mountMultiFactor([]);
    auditMock.mockResolvedValue({ ok: false, error: { code: "invalid", message: "x" } });
    render(<MfaEnrollment />);

    await startEnrollAndEnterCode();
    fireEvent.click(screen.getByRole("button", { name: "登録を確定" }));

    expect(
      await screen.findByText(/登録は完了しましたが監査記録に失敗しました/),
    ).toBeInTheDocument();
  });

  it("enroll 成功 + 監査成功なら成功メッセージと refresh (非空虚: 成功経路)", async () => {
    mountMultiFactor([]);
    render(<MfaEnrollment />);

    await startEnrollAndEnterCode();
    fireEvent.click(screen.getByRole("button", { name: "登録を確定" }));

    expect(await screen.findByText("二要素認証を登録しました。")).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("enroll 自体が失敗したら登録失敗エラーを表示し監査を呼ばない (取り違え防止が本物の失敗を握り潰さない)", async () => {
    const mf = mountMultiFactor([]);
    mf.enroll.mockRejectedValue(new Error("wrong code")); // enroll 自体が失敗
    render(<MfaEnrollment />);

    await startEnrollAndEnterCode("000000");
    fireEvent.click(screen.getByRole("button", { name: "登録を確定" }));

    expect(await screen.findByText(/コードが正しくないか、登録に失敗しました/)).toBeInTheDocument();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("unenroll 成功後に監査が throw しても『解除は成功・監査のみ失敗』を表示 (解除失敗と取り違えない)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountMultiFactor([{ uid: "f1", displayName: "Authenticator アプリ" }]);
    auditMock.mockRejectedValue(new Error("IdP transient"));
    render(<MfaEnrollment />);

    fireEvent.click(await screen.findByRole("button", { name: "解除" }));

    expect(
      await screen.findByText(/解除は完了しましたが監査記録に失敗しました/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/解除に失敗しました/)).not.toBeInTheDocument();
  });

  it("unenroll 自体が失敗したら解除失敗エラーを表示し監査を呼ばない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const mf = mountMultiFactor([{ uid: "f1", displayName: "Authenticator アプリ" }]);
    mf.unenroll.mockRejectedValue(new Error("requires recent login"));
    render(<MfaEnrollment />);

    fireEvent.click(await screen.findByRole("button", { name: "解除" }));

    expect(await screen.findByText(/解除に失敗しました/)).toBeInTheDocument();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
