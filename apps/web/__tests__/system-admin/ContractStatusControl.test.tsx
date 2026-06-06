import { ToastProvider } from "@kimiterrace/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): ContractStatusControl のテスト。updateContractStatusAction と router を mock。
 * 現在ステータスから許可された遷移ボタンだけを出すこと・共通 ConfirmDialog 確定後に対象 status で action を
 * 呼び refresh + 成功トースト、確認キャンセルで未送信、terminated は遷移ボタン無し (—)、失敗時のエラー表示を
 * 検証。`window.confirm`→ConfirmDialog + Toast 化に追従。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/contracts-actions", () => ({ updateContractStatusAction: vi.fn() }));

import type { ContractStatus } from "../../lib/system-admin/contracts-core";
import { ContractStatusControl } from "../../app/admin/system/advertisers/[id]/contracts/_components/ContractStatusControl";
import { updateContractStatusAction } from "../../lib/system-admin/contracts-actions";

const actionMock = vi.mocked(updateContractStatusAction);
const CONTRACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function renderControl(status: ContractStatus) {
  return render(
    <ToastProvider>
      <ContractStatusControl contractId={CONTRACT_ID} status={status} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ContractStatusControl (#46 状態遷移ボタン)", () => {
  it("active は許可遷移 (一時停止 / 終了) のみ出す。逆走/同一は出さない", () => {
    renderControl("active");
    expect(screen.getByRole("button", { name: /一時停止/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /終了/ })).toBeTruthy();
    // active→draft / active→active(同一) のボタンは無い。
    expect(screen.queryByRole("button", { name: /下書き/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /稼働中/ })).toBeNull();
  });

  it("確認確定後に対象 status で action を呼ぶ → refresh + 成功トースト", async () => {
    actionMock.mockResolvedValue({ ok: true, data: { id: CONTRACT_ID, status: "paused" } });
    renderControl("active");
    fireEvent.click(screen.getByRole("button", { name: /一時停止/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("一時停止");
    expect(actionMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "変更する" }));
    await waitFor(() =>
      expect(actionMock).toHaveBeenCalledWith({ id: CONTRACT_ID, status: "paused" }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText(/「一時停止」に変更しました/)).toBeInTheDocument();
  });

  it("確認キャンセルで action を呼ばない", async () => {
    renderControl("active");
    fireEvent.click(screen.getByRole("button", { name: /終了/ }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(actionMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("terminated は終端で遷移ボタン無し (—)", () => {
    renderControl("terminated");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("失敗時はエラーメッセージを表示し refresh しない", async () => {
    actionMock.mockResolvedValue({
      ok: false,
      error: { code: "conflict", message: "ステータス変更に失敗(テスト)" },
    });
    renderControl("draft");
    fireEvent.click(screen.getByRole("button", { name: /終了/ }));
    fireEvent.click(await screen.findByRole("button", { name: "変更する" }));
    await screen.findByText("ステータス変更に失敗(テスト)");
    expect(refresh).not.toHaveBeenCalled();
  });
});
