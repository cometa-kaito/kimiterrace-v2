import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): ContractStatusControl のテスト。updateContractStatusAction と router を mock。
 * 現在ステータスから許可された遷移ボタンだけを出すこと・confirm 後に対象 status で action を呼び refresh、
 * confirm キャンセルで未送信、terminated は遷移ボタン無し (—)、失敗時のエラー表示を検証。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/contracts-actions", () => ({ updateContractStatusAction: vi.fn() }));

import { ContractStatusControl } from "../../app/admin/system/advertisers/[id]/contracts/_components/ContractStatusControl";
import { updateContractStatusAction } from "../../lib/system-admin/contracts-actions";

const actionMock = vi.mocked(updateContractStatusAction);
const CONTRACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ContractStatusControl (#46 状態遷移ボタン)", () => {
  it("active は許可遷移 (一時停止 / 終了) のみ出す。逆走/同一は出さない", () => {
    render(<ContractStatusControl contractId={CONTRACT_ID} status="active" />);
    expect(screen.getByRole("button", { name: /一時停止/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /終了/ })).toBeTruthy();
    // active→draft / active→active(同一) のボタンは無い。
    expect(screen.queryByRole("button", { name: /下書き/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /稼働中/ })).toBeNull();
  });

  it("confirm 後に対象 status で action を呼ぶ → refresh", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    actionMock.mockResolvedValue({ ok: true, data: { id: CONTRACT_ID, status: "paused" } });
    render(<ContractStatusControl contractId={CONTRACT_ID} status="active" />);
    fireEvent.click(screen.getByRole("button", { name: /一時停止/ }));
    await waitFor(() =>
      expect(actionMock).toHaveBeenCalledWith({ id: CONTRACT_ID, status: "paused" }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("confirm キャンセルで action を呼ばない", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ContractStatusControl contractId={CONTRACT_ID} status="active" />);
    fireEvent.click(screen.getByRole("button", { name: /終了/ }));
    expect(actionMock).not.toHaveBeenCalled();
  });

  it("terminated は終端で遷移ボタン無し (—)", () => {
    render(<ContractStatusControl contractId={CONTRACT_ID} status="terminated" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("失敗時はエラーメッセージを表示し refresh しない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    actionMock.mockResolvedValue({
      ok: false,
      error: { code: "conflict", message: "ステータス変更に失敗(テスト)" },
    });
    render(<ContractStatusControl contractId={CONTRACT_ID} status="draft" />);
    fireEvent.click(screen.getByRole("button", { name: /終了/ }));
    await screen.findByText("ステータス変更に失敗(テスト)");
    expect(refresh).not.toHaveBeenCalled();
  });
});
