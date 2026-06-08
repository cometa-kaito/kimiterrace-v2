import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * fix #2: ログイン後のパスワード変更 (`/admin/account/password`) の挙動。
 *
 * 検証する不変条件:
 * - 正常: 現在PWで再認証 (`signInWithEmailAndPassword`) → `updatePassword` → 成功表示。currentUser に依存
 *   しないことが核心 (cookie session 遷移で currentUser 喪失しても変更できる)。
 * - 現在PW誤り (auth/wrong-password 等) は「現在のパスワードが正しくありません」。
 * - 入力検証 (確認不一致 / 短すぎ) は再認証 SDK を呼ぶ前に弾く (非空虚)。
 * - email が取得できない (claim 欠落) ときは再ログイン導線を出す (詰み防止)。
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
  signInWithEmailAndPassword: vi.fn(),
  updatePassword: vi.fn(),
}));
vi.mock("../../lib/auth/clientApp", () => ({ getClientAuth: vi.fn(() => ({})) }));

import { signInWithEmailAndPassword, updatePassword } from "firebase/auth";
import { ChangePasswordForm } from "../../app/admin/account/password/_components/ChangePasswordForm";

const signInMock = vi.mocked(signInWithEmailAndPassword);
const updatePasswordMock = vi.mocked(updatePassword);
const FAKE_USER = { uid: "u1" };

beforeEach(() => {
  vi.clearAllMocks();
  signInMock.mockResolvedValue({ user: FAKE_USER } as unknown as Awaited<
    ReturnType<typeof signInWithEmailAndPassword>
  >);
  updatePasswordMock.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function fill(current: string, pw: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("現在のパスワード"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("新しいパスワード"), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText("新しいパスワード（確認）"), {
    target: { value: confirm },
  });
}

describe("ChangePasswordForm", () => {
  it("正常: 現在PWで再認証 → updatePassword → 成功表示 (currentUser 非依存)", async () => {
    render(<ChangePasswordForm email="admin@example.com" />);
    fill("oldpass12", "newpassword1", "newpassword1");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを変更" }));

    expect(await screen.findByText(/パスワードを変更しました/)).toBeInTheDocument();
    expect(signInMock).toHaveBeenCalledWith(expect.anything(), "admin@example.com", "oldpass12");
    expect(updatePasswordMock).toHaveBeenCalledWith(FAKE_USER, "newpassword1");
  });

  it("現在PWが誤り (auth/wrong-password) はその旨を表示、updatePassword を呼ばない", async () => {
    signInMock.mockRejectedValue({ code: "auth/wrong-password" });
    render(<ChangePasswordForm email="admin@example.com" />);
    fill("bad", "newpassword1", "newpassword1");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを変更" }));

    expect(await screen.findByText("現在のパスワードが正しくありません。")).toBeInTheDocument();
    expect(updatePasswordMock).not.toHaveBeenCalled();
  });

  it("invalid-credential も現在PW誤りとして扱う (新 SDK のエラーコード)", async () => {
    signInMock.mockRejectedValue({ code: "auth/invalid-credential" });
    render(<ChangePasswordForm email="admin@example.com" />);
    fill("bad", "newpassword1", "newpassword1");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを変更" }));

    expect(await screen.findByText("現在のパスワードが正しくありません。")).toBeInTheDocument();
  });

  it("確認が一致しないと error、再認証 SDK を呼ばない (非空虚)", async () => {
    render(<ChangePasswordForm email="admin@example.com" />);
    fill("oldpass12", "newpassword1", "different123");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを変更" }));

    expect(await screen.findByText("確認用パスワードが一致しません。")).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("短すぎる新パスワードは error、再認証 SDK を呼ばない", async () => {
    render(<ChangePasswordForm email="admin@example.com" />);
    fill("oldpass12", "short", "short");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを変更" }));

    expect(await screen.findByText(/8 文字以上/)).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("email が無い (claim 欠落) ときは再ログイン導線を出しフォームは出さない (詰み防止)", () => {
    render(<ChangePasswordForm email={null} />);
    expect(screen.getByRole("link", { name: "ログインし直す" })).toHaveAttribute(
      "href",
      "/login?next=/admin/account/password",
    );
    expect(screen.queryByRole("button", { name: "パスワードを変更" })).not.toBeInTheDocument();
  });

  it("成功後はエラーが残らない (二重障害の取り違え防止の回帰)", async () => {
    render(<ChangePasswordForm email="admin@example.com" />);
    fill("oldpass12", "newpassword1", "newpassword1");
    fireEvent.click(screen.getByRole("button", { name: "パスワードを変更" }));
    await waitFor(() => expect(screen.getByText(/パスワードを変更しました/)).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
