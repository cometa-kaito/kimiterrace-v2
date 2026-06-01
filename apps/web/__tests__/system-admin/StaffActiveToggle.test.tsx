import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324): StaffActiveToggle のテスト。setStaffActiveAction と router を mock し、無効化は confirm を
 * 要求して反転値で action を呼ぶこと・再有効化は confirm 不要・キャンセルで未送信・失敗 (last-admin 等) の
 * 表示を検証。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/users-actions", () => ({ setStaffActiveAction: vi.fn() }));

import { StaffActiveToggle } from "../../app/admin/system/users/_components/StaffActiveToggle";
import { setStaffActiveAction } from "../../lib/system-admin/users-actions";

const toggleMock = vi.mocked(setStaffActiveAction);
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("StaffActiveToggle (#324 全校無効化トグル)", () => {
  it("稼働中は「無効化」を表示し、confirm 後に isActive=false で呼ぶ → refresh", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    toggleMock.mockResolvedValue({ ok: true, data: { id: USER_ID, isActive: false } });
    render(
      <StaffActiveToggle
        userId={USER_ID}
        isActive={true}
        displayName="山田先生"
        schoolName="テスト高校 A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    await waitFor(() =>
      expect(toggleMock).toHaveBeenCalledWith({ userId: USER_ID, isActive: false }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("無効化を confirm キャンセルすると action を呼ばない", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <StaffActiveToggle
        userId={USER_ID}
        isActive={true}
        displayName="山田先生"
        schoolName="テスト高校 A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    expect(toggleMock).not.toHaveBeenCalled();
  });

  it("無効状態は「再有効化」を表示し、confirm なしで isActive=true で呼ぶ", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    toggleMock.mockResolvedValue({ ok: true, data: { id: USER_ID, isActive: true } });
    render(
      <StaffActiveToggle
        userId={USER_ID}
        isActive={false}
        displayName="山田先生"
        schoolName="テスト高校 A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "再有効化" }));
    await waitFor(() =>
      expect(toggleMock).toHaveBeenCalledWith({ userId: USER_ID, isActive: true }),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("失敗時 (last-admin 等) は error を表示し refresh しない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    toggleMock.mockResolvedValue({
      ok: false,
      error: {
        code: "conflict",
        message: "この学校で唯一の有効な学校管理者のため無効化できません。",
      },
    });
    render(
      <StaffActiveToggle
        userId={USER_ID}
        isActive={true}
        displayName="管理者A"
        schoolName="テスト高校 A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    expect(await screen.findByText(/唯一の有効な学校管理者/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
