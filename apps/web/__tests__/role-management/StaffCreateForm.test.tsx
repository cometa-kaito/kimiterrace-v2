import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#508): StaffCreateForm のテスト。createStaffAction を mock し、入力値で action を呼ぶこと・
 * 成功で **初回パスワード設定リンク (setupLink) を表示**すること・失敗でエラー表示・コピー操作を検証。
 * 認可/検証/IdP/監査は Server Action 側 (#512 で実証済) の責務なので、ここは UI 配線のみ固める。
 */

vi.mock("@/lib/role-management/member-actions", () => ({ createStaffAction: vi.fn() }));

import { StaffCreateForm } from "../../app/admin/school/members/new/_components/StaffCreateForm";
import { createStaffAction } from "../../lib/role-management/member-actions";

const createMock = vi.mocked(createStaffAction);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fill(email = "teacher@example.com", displayName = "山田先生") {
  fireEvent.change(screen.getByLabelText(/メールアドレス/), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/表示名/), { target: { value: displayName } });
}

describe("StaffCreateForm (#508 発行フォーム)", () => {
  it("発行できるのは教員のみと明示する (role 境界の可視化)", () => {
    render(<StaffCreateForm />);
    expect(screen.getByText(/発行できるのは/)).toBeInTheDocument();
  });

  it("送信で {email, displayName} を渡して action を呼び、成功で初回設定リンクを表示する", async () => {
    createMock.mockResolvedValue({
      ok: true,
      data: { id: "u1", setupLink: "https://idp/reset?code=abc" },
    });
    render(<StaffCreateForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        email: "teacher@example.com",
        displayName: "山田先生",
      }),
    );
    // 成功 UI: setupLink を表示し、入力フォーム (発行ボタン) は消える。
    const linkInput = await screen.findByLabelText("初回パスワード設定リンク");
    expect(linkInput).toHaveValue("https://idp/reset?code=abc");
    expect(screen.queryByRole("button", { name: "発行する" })).not.toBeInTheDocument();
  });

  it("失敗時はエラーメッセージを表示し、成功 UI (setupLink) を出さない", async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { code: "conflict", message: "このメールアドレスは既に登録されています。" },
    });
    render(<StaffCreateForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    await screen.findByText("このメールアドレスは既に登録されています。");
    expect(screen.queryByLabelText("初回パスワード設定リンク")).not.toBeInTheDocument();
  });

  it("コピーボタンで setupLink をクリップボードへ書き込む", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    createMock.mockResolvedValue({
      ok: true,
      data: { id: "u1", setupLink: "https://idp/reset?code=xyz" },
    });
    render(<StaffCreateForm />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    const copyBtn = await screen.findByRole("button", { name: "リンクをコピー" });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://idp/reset?code=xyz"));
  });
});
