import { ToastProvider } from "@kimiterrace/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): AdvertiserActiveToggle のテスト。setAdvertiserActiveAction と router を mock し、停止は共通
 * ConfirmDialog で確認して反転値で action を呼ぶこと・再開は確認不要・キャンセルで未送信・失敗時の表示・
 * 成功トーストを検証。`window.confirm`→ConfirmDialog + Toast 化に追従。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/advertisers-actions", () => ({ setAdvertiserActiveAction: vi.fn() }));

import { AdvertiserActiveToggle } from "../../app/admin/system/advertisers/_components/AdvertiserActiveToggle";
import { setAdvertiserActiveAction } from "../../lib/system-admin/advertisers-actions";

const toggleMock = vi.mocked(setAdvertiserActiveAction);
const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function renderToggle(isActive: boolean) {
  return render(
    <ToastProvider>
      <AdvertiserActiveToggle advertiserId={ADV_ID} isActive={isActive} companyName="アクメ商事" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdvertiserActiveToggle (#46 稼働トグル)", () => {
  it("稼働中は「停止」を表示し、確認ダイアログ確定後に isActive=false で呼ぶ → refresh + 成功トースト", async () => {
    toggleMock.mockResolvedValue({ ok: true, data: { id: ADV_ID, isActive: false } });
    renderToggle(true);

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(toggleMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("アクメ商事");

    fireEvent.click(screen.getByRole("button", { name: "停止する" }));
    await waitFor(() => expect(toggleMock).toHaveBeenCalledWith({ id: ADV_ID, isActive: false }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText("「アクメ商事」を停止しました")).toBeInTheDocument();
  });

  it("確認ダイアログをキャンセルすると action を呼ばない", async () => {
    renderToggle(true);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(toggleMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("停止中は「再開」を表示し、確認なしで isActive=true で呼ぶ", async () => {
    toggleMock.mockResolvedValue({ ok: true, data: { id: ADV_ID, isActive: true } });
    renderToggle(false);
    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    await waitFor(() => expect(toggleMock).toHaveBeenCalledWith({ id: ADV_ID, isActive: true }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("失敗時は error を表示し refresh しない", async () => {
    toggleMock.mockResolvedValue({
      ok: false,
      error: { code: "not_found", message: "指定された広告主が見つかりません。" },
    });
    renderToggle(true);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    fireEvent.click(await screen.findByRole("button", { name: "停止する" }));
    expect(await screen.findByText(/見つかりません/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
