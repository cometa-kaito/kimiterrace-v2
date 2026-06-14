import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#508): SystemStaffCreateForm のテスト。createSystemStaffAction を mock し、入力値
 * (email/displayName/schoolId) で action を呼ぶこと・成功で **初回パスワード設定リンク (setupLink)**
 * を表示すること・失敗でエラー表示・コピー操作・学校 0 件のガードを検証する。認可/検証/対象校実在確認/
 * IdP/監査は Server Action 側 (create-system-staff.test.ts で実証済) の責務なので、ここは UI 配線のみ固める。
 *
 * 教員アカウント概念の撤去 (2026-06-10): 発行は学校管理者のみ (ロール選択 UI は撤去)。action へ role は渡さない。
 */

vi.mock("@/lib/system-admin/users-actions", () => ({ createSystemStaffAction: vi.fn() }));

import { SystemStaffCreateForm } from "../../app/ops/users/new/_components/SystemStaffCreateForm";
import { createSystemStaffAction } from "../../lib/system-admin/users-actions";

const createMock = vi.mocked(createSystemStaffAction);

const GINAN = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "岐南工業高校",
  prefecture: "岐阜県",
};
const E2E = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "E2Eテスト高校",
  prefecture: "東京都",
};
const SCHOOLS = [GINAN, E2E];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fill(opts?: { schoolId?: string; email?: string; displayName?: string }) {
  const schoolId = opts?.schoolId ?? GINAN.id;
  const email = opts?.email ?? "admin@example.com";
  const displayName = opts?.displayName ?? "学校管理者A";
  // ロール選択は撤去 (常に school_admin)。ラベルは「学校」「メールアドレス」「表示名」(必須印 * は aria-hidden)。
  fireEvent.change(screen.getByRole("combobox", { name: "学校" }), { target: { value: schoolId } });
  fireEvent.change(screen.getByRole("textbox", { name: "メールアドレス" }), {
    target: { value: email },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "表示名" }), {
    target: { value: displayName },
  });
}

describe("SystemStaffCreateForm (#508 system_admin 発行フォーム)", () => {
  it("学校が 0 件なら発行できず、学校登録へ誘導する", () => {
    render(<SystemStaffCreateForm schools={[]} />);
    expect(screen.getByText(/発行先の学校がありません/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "発行する" })).not.toBeInTheDocument();
  });

  it("空送信は項目別エラー (学校未選択 + email/表示名) を出し、action を呼ばない", () => {
    render(<SystemStaffCreateForm schools={SCHOOLS} />);
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByText("発行先の学校を選択してください。")).toBeInTheDocument();
    expect(screen.getByText("メールアドレスの形式が不正です。")).toBeInTheDocument();
    expect(screen.getByText("表示名を入力してください (100 文字以内)。")).toBeInTheDocument();
  });

  it("学校を選ばずに他項目を埋めても、学校エラーで送信しない", () => {
    render(<SystemStaffCreateForm schools={SCHOOLS} />);
    fireEvent.change(screen.getByRole("textbox", { name: "メールアドレス" }), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "表示名" }), {
      target: { value: "学校管理者A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    expect(createMock).not.toHaveBeenCalled();
    expect(screen.getByText("発行先の学校を選択してください。")).toBeInTheDocument();
  });

  it("送信で {email, displayName, schoolId} を渡し (role は送らない)、成功で初回設定リンクを表示する", async () => {
    createMock.mockResolvedValue({
      ok: true,
      data: { id: "u1", setupLink: "https://idp/reset?code=abc" },
    });
    render(<SystemStaffCreateForm schools={SCHOOLS} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        email: "admin@example.com",
        displayName: "学校管理者A",
        schoolId: GINAN.id,
      }),
    );
    const linkInput = await screen.findByLabelText("初回パスワード設定リンク");
    expect(linkInput).toHaveValue("https://idp/reset?code=abc");
    expect(screen.queryByRole("button", { name: "発行する" })).not.toBeInTheDocument();
  });

  it("ロール選択 UI は出さない (常に学校管理者・教員アカウント概念の撤去)", () => {
    render(<SystemStaffCreateForm schools={SCHOOLS} />);
    expect(screen.queryByRole("combobox", { name: "ロール" })).not.toBeInTheDocument();
  });

  it("失敗時はエラーメッセージを表示し、成功 UI (setupLink) を出さない", async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { code: "conflict", message: "このメールアドレスは既に登録されています。" },
    });
    render(<SystemStaffCreateForm schools={SCHOOLS} />);
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
    render(<SystemStaffCreateForm schools={SCHOOLS} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    const copyBtn = await screen.findByRole("button", { name: "リンクをコピー" });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://idp/reset?code=xyz"));
  });
});
