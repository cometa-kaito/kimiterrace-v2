import { ToastProvider } from "@kimiterrace/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324, ADR-026 D2): StaffRoleToggle のテスト。changeStaffRoleAction と router を mock し、
 * 変更先ロールのラベル表示・共通 ConfirmDialog 確定後に反対ロールで action を呼ぶこと・キャンセルで
 * 未送信・失敗 (唯一の有効な学校管理者の降格など) の表示・成功トーストを検証。`window.confirm`→
 * ConfirmDialog + Toast 化に追従。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/users-actions", () => ({ changeStaffRoleAction: vi.fn() }));

import { StaffRoleToggle } from "../../app/admin/system/users/_components/StaffRoleToggle";
import { changeStaffRoleAction } from "../../lib/system-admin/users-actions";

const changeMock = vi.mocked(changeStaffRoleAction);
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function renderToggle(currentRole: "school_admin" | "teacher", displayName = "山田先生") {
  return render(
    <ToastProvider>
      <StaffRoleToggle
        userId={USER_ID}
        currentRole={currentRole}
        displayName={displayName}
        schoolName="テスト高校 A"
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("StaffRoleToggle (#324 D2 ロール変更トグル)", () => {
  it("teacher 行は「学校管理者に変更」を表示し、確認確定後に nextRole=school_admin で呼ぶ → refresh + 成功トースト", async () => {
    changeMock.mockResolvedValue({ ok: true, data: { id: USER_ID, role: "school_admin" } });
    renderToggle("teacher");

    fireEvent.click(screen.getByRole("button", { name: "学校管理者に変更" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("学校管理者に変更しますか");

    fireEvent.click(screen.getByRole("button", { name: "変更する" }));
    await waitFor(() =>
      expect(changeMock).toHaveBeenCalledWith({ userId: USER_ID, nextRole: "school_admin" }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(
      await screen.findByText("テスト高校 A「山田先生」を学校管理者に変更しました"),
    ).toBeInTheDocument();
  });

  it("school_admin 行は「教員に変更」を表示し、確認確定後に nextRole=teacher で呼ぶ", async () => {
    changeMock.mockResolvedValue({ ok: true, data: { id: USER_ID, role: "teacher" } });
    renderToggle("school_admin", "管理者A");
    fireEvent.click(screen.getByRole("button", { name: "教員に変更" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "変更する" }));
    await waitFor(() =>
      expect(changeMock).toHaveBeenCalledWith({ userId: USER_ID, nextRole: "teacher" }),
    );
  });

  it("確認ダイアログをキャンセルすると action を呼ばない (ロール変更は常に確認する)", async () => {
    renderToggle("teacher");
    fireEvent.click(screen.getByRole("button", { name: "学校管理者に変更" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(changeMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("失敗時 (last-admin 降格など) は error を表示し refresh しない", async () => {
    changeMock.mockResolvedValue({
      ok: false,
      error: {
        code: "conflict",
        message: "この学校で唯一の有効な学校管理者のため教員に変更できません。",
      },
    });
    renderToggle("school_admin", "管理者A");
    fireEvent.click(screen.getByRole("button", { name: "教員に変更" }));
    fireEvent.click(await screen.findByRole("button", { name: "変更する" }));
    expect(await screen.findByText(/唯一の有効な学校管理者/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
