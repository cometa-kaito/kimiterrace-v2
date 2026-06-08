import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * fix #1: 自前リセットページ (`/reset-password`) の挙動。
 *
 * 検証する不変条件:
 * - oobCode が無い / 検証失敗 (期限切れ) → 「無効」画面で **必ずログイン画面への導線**を出す (詰み防止)。
 * - 正常: 検証成功 → 新パスワード入力 → 確定成功 → **完了画面でログイン画面への大きな導線** (本 fix の核心)。
 * - 入力検証 (確認不一致 / 短すぎ) は client で弾き confirmPasswordReset を呼ばない (非空虚)。
 *
 * firebase client SDK (`verifyPasswordResetCode` / `confirmPasswordReset`)・getClientAuth・next/link を mock。
 */

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("firebase/auth", () => ({
  verifyPasswordResetCode: vi.fn(),
  confirmPasswordReset: vi.fn(),
}));
vi.mock("../../lib/auth/clientApp", () => ({ getClientAuth: vi.fn(() => ({})) }));

import { confirmPasswordReset, verifyPasswordResetCode } from "firebase/auth";
import { ResetPasswordForm } from "../../app/reset-password/_components/ResetPasswordForm";

const verifyMock = vi.mocked(verifyPasswordResetCode);
const confirmMock = vi.mocked(confirmPasswordReset);

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockResolvedValue("user@example.com");
  confirmMock.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

/** 検証成功後のフォームまで進めて新パスワードを入力する。 */
async function fillForm(pw: string, confirm: string) {
  await screen.findByText("パスワードの設定");
  fireEvent.change(screen.getByLabelText("新しいパスワード"), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText("新しいパスワード（確認）"), {
    target: { value: confirm },
  });
}

describe("ResetPasswordForm", () => {
  it("oobCode が無いと無効画面 + ログイン画面への導線 (検証 SDK を呼ばない)", async () => {
    render(<ResetPasswordForm oobCode={null} />);
    expect(await screen.findByText("リンクが無効です")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ログイン画面へ" })).toHaveAttribute("href", "/login");
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("検証失敗 (期限切れ) は無効画面 + ログイン導線", async () => {
    verifyMock.mockRejectedValue({ code: "auth/expired-action-code" });
    render(<ResetPasswordForm oobCode="OOB" />);
    expect(await screen.findByText("リンクが無効です")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ログイン画面へ" })).toHaveAttribute("href", "/login");
  });

  it("正常: 検証 → 設定 → 完了画面でログイン画面への導線を出す (fix #1 の核心)", async () => {
    render(<ResetPasswordForm oobCode="OOB" />);
    await fillForm("newpassword1", "newpassword1");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを設定" }));

    expect(await screen.findByText("パスワードを設定しました")).toBeInTheDocument();
    expect(confirmMock).toHaveBeenCalledWith(expect.anything(), "OOB", "newpassword1");
    // 完了画面に「ログイン画面へ」ボタン (/login) がある = ここから簡単にログインへ飛べる。
    expect(screen.getByRole("link", { name: "ログイン画面へ" })).toHaveAttribute("href", "/login");
  });

  it("確認が一致しないと error、confirmPasswordReset を呼ばない (非空虚)", async () => {
    render(<ResetPasswordForm oobCode="OOB" />);
    await fillForm("newpassword1", "different123");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを設定" }));

    expect(await screen.findByText("確認用パスワードが一致しません。")).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("短すぎるパスワードは error、confirmPasswordReset を呼ばない", async () => {
    render(<ResetPasswordForm oobCode="OOB" />);
    await fillForm("short", "short");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを設定" }));

    expect(await screen.findByText(/8 文字以上/)).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("確定の段で期限切れ (auth/expired-action-code) なら無効画面へ倒す", async () => {
    confirmMock.mockRejectedValue({ code: "auth/expired-action-code" });
    render(<ResetPasswordForm oobCode="OOB" />);
    await fillForm("newpassword1", "newpassword1");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを設定" }));

    await waitFor(() => expect(screen.getByText("リンクが無効です")).toBeInTheDocument());
  });
});
