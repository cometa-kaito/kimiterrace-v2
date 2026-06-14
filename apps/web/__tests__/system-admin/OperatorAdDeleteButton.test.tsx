import { ToastProvider } from "@kimiterrace/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 / #46: OperatorAdDeleteButton の検証。deleteOperatorAdAction と router を mock。確認ダイアログ確定で
 * 削除 → 成功トースト、キャンセルで未送信、を検証する。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/operator-ads-actions", () => ({ deleteOperatorAdAction: vi.fn() }));

import { OperatorAdDeleteButton } from "../../app/ops/advertisers/[id]/ads/_components/OperatorAdDeleteButton";
import { deleteOperatorAdAction } from "../../lib/system-admin/operator-ads-actions";

const deleteMock = vi.mocked(deleteOperatorAdAction);
const AD_ID = "44444444-4444-4444-8444-444444444444";

function renderButton() {
  return render(
    <ToastProvider>
      <OperatorAdDeleteButton adId={AD_ID} label="岐南工業高校 の広告" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("OperatorAdDeleteButton", () => {
  it("確認ダイアログ確定で deleteOperatorAdAction を呼び refresh + 成功トースト", async () => {
    deleteMock.mockResolvedValue({ ok: true, data: { id: AD_ID } });
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "岐南工業高校 の広告 を削除" }));
    await screen.findByRole("alertdialog");
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(AD_ID));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText("広告を削除しました")).toBeInTheDocument();
  });

  it("確認をキャンセルすると削除しない", async () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "岐南工業高校 の広告 を削除" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(deleteMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
