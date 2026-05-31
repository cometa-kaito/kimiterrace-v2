import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): AdvertiserActiveToggle のテスト。setAdvertiserActiveAction と router を mock し、停止は
 * confirm を要求して反転値で action を呼ぶこと・再開は confirm 不要・キャンセルで未送信・失敗時の表示を検証。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/advertisers-actions", () => ({ setAdvertiserActiveAction: vi.fn() }));

import { AdvertiserActiveToggle } from "../../app/admin/system/advertisers/_components/AdvertiserActiveToggle";
import { setAdvertiserActiveAction } from "../../lib/system-admin/advertisers-actions";

const toggleMock = vi.mocked(setAdvertiserActiveAction);
const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdvertiserActiveToggle (#46 稼働トグル)", () => {
  it("稼働中は「停止」を表示し、confirm 後に isActive=false で呼ぶ → refresh", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    toggleMock.mockResolvedValue({ ok: true, data: { id: ADV_ID, isActive: false } });
    render(
      <AdvertiserActiveToggle advertiserId={ADV_ID} isActive={true} companyName="アクメ商事" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(toggleMock).toHaveBeenCalledWith({ id: ADV_ID, isActive: false }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("停止を confirm キャンセルすると action を呼ばない", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <AdvertiserActiveToggle advertiserId={ADV_ID} isActive={true} companyName="アクメ商事" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(toggleMock).not.toHaveBeenCalled();
  });

  it("停止中は「再開」を表示し、confirm なしで isActive=true で呼ぶ", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    toggleMock.mockResolvedValue({ ok: true, data: { id: ADV_ID, isActive: true } });
    render(
      <AdvertiserActiveToggle advertiserId={ADV_ID} isActive={false} companyName="アクメ商事" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    await waitFor(() => expect(toggleMock).toHaveBeenCalledWith({ id: ADV_ID, isActive: true }));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("失敗時は error を表示し refresh しない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    toggleMock.mockResolvedValue({
      ok: false,
      error: { code: "not_found", message: "指定された広告主が見つかりません。" },
    });
    render(
      <AdvertiserActiveToggle advertiserId={ADV_ID} isActive={true} companyName="アクメ商事" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByText(/見つかりません/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
