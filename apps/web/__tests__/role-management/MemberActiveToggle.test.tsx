import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324): MemberActiveToggle のテスト。setMemberActiveAction と router を mock し、無効化は confirm を
 * 要求して反転値で action を呼ぶこと・再有効化は confirm 不要・キャンセルで未送信・失敗時の表示を検証。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/role-management/member-actions", () => ({ setMemberActiveAction: vi.fn() }));

import { MemberActiveToggle } from "../../app/admin/school/members/_components/MemberActiveToggle";
import { setMemberActiveAction } from "../../lib/role-management/member-actions";

const toggleMock = vi.mocked(setMemberActiveAction);
const TEACHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("MemberActiveToggle (#324 無効化トグル)", () => {
  it("稼働中は「無効化」を表示し、confirm 後に isActive=false で呼ぶ → refresh", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    toggleMock.mockResolvedValue({ ok: true, data: { id: TEACHER_ID, isActive: false } });
    render(<MemberActiveToggle userId={TEACHER_ID} isActive={true} displayName="山田先生" />);
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    await waitFor(() =>
      expect(toggleMock).toHaveBeenCalledWith({ userId: TEACHER_ID, isActive: false }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("無効化を confirm キャンセルすると action を呼ばない", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<MemberActiveToggle userId={TEACHER_ID} isActive={true} displayName="山田先生" />);
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    expect(toggleMock).not.toHaveBeenCalled();
  });

  it("無効状態は「再有効化」を表示し、confirm なしで isActive=true で呼ぶ", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    toggleMock.mockResolvedValue({ ok: true, data: { id: TEACHER_ID, isActive: true } });
    render(<MemberActiveToggle userId={TEACHER_ID} isActive={false} displayName="山田先生" />);
    fireEvent.click(screen.getByRole("button", { name: "再有効化" }));
    await waitFor(() =>
      expect(toggleMock).toHaveBeenCalledWith({ userId: TEACHER_ID, isActive: true }),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("失敗時は error を表示し refresh しない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    toggleMock.mockResolvedValue({
      ok: false,
      error: { code: "forbidden", message: "権限がありません。" },
    });
    render(<MemberActiveToggle userId={TEACHER_ID} isActive={true} displayName="山田先生" />);
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    expect(await screen.findByText(/権限がありません/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
