import { ToastProvider } from "@kimiterrace/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324): StaffActiveToggle のテスト。setStaffActiveAction と router を mock し、無効化は共通
 * ConfirmDialog で確認してから反転値で action を呼ぶこと・再有効化は確認不要・キャンセルで未送信・
 * 失敗 (last-admin 等) の表示・成功トーストを検証。`window.confirm`→ConfirmDialog + Toast 化に追従。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/users-actions", () => ({ setStaffActiveAction: vi.fn() }));

import { StaffActiveToggle } from "../../app/ops/users/_components/StaffActiveToggle";
import { setStaffActiveAction } from "../../lib/system-admin/users-actions";

const toggleMock = vi.mocked(setStaffActiveAction);
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function renderToggle(isActive: boolean, displayName = "山田先生") {
  return render(
    <ToastProvider>
      <StaffActiveToggle
        userId={USER_ID}
        isActive={isActive}
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

describe("StaffActiveToggle (#324 全校無効化トグル)", () => {
  it("稼働中は「無効化」を表示し、確認ダイアログ確定後に isActive=false で呼ぶ → refresh + 成功トースト", async () => {
    toggleMock.mockResolvedValue({ ok: true, data: { id: USER_ID, isActive: false } });
    renderToggle(true);

    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    expect(toggleMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("山田先生");

    fireEvent.click(screen.getByRole("button", { name: "無効化する" }));
    await waitFor(() =>
      expect(toggleMock).toHaveBeenCalledWith({ userId: USER_ID, isActive: false }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("テスト高校 A「山田先生」を無効化しました")).toBeInTheDocument();
  });

  it("確認ダイアログをキャンセルすると action を呼ばない", async () => {
    renderToggle(true);
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(toggleMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("無効状態は「再有効化」を表示し、確認なしで isActive=true で呼ぶ", async () => {
    toggleMock.mockResolvedValue({ ok: true, data: { id: USER_ID, isActive: true } });
    renderToggle(false);
    fireEvent.click(screen.getByRole("button", { name: "再有効化" }));
    await waitFor(() =>
      expect(toggleMock).toHaveBeenCalledWith({ userId: USER_ID, isActive: true }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("失敗時 (last-admin 等) は error を表示し refresh しない", async () => {
    toggleMock.mockResolvedValue({
      ok: false,
      error: {
        code: "conflict",
        message: "この学校で唯一の有効な学校管理者のため無効化できません。",
      },
    });
    renderToggle(true, "管理者A");
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    fireEvent.click(await screen.findByRole("button", { name: "無効化する" }));
    expect(await screen.findByText(/唯一の有効な学校管理者/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
