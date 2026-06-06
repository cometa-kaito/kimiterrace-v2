import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324): MemberActiveToggle のテスト。setMemberActiveAction と router を mock し、無効化は
 * ConfirmDialog (共通 UI) で確認してから反転値で action を呼ぶこと・再有効化は確認不要・キャンセルで
 * 未送信・失敗時の表示を検証。`window.confirm` 置換 (共通 ConfirmDialog) に追従。
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
  it("稼働中は「無効化」を表示し、確認ダイアログ確定後に isActive=false で呼ぶ → refresh", async () => {
    toggleMock.mockResolvedValue({ ok: true, data: { id: TEACHER_ID, isActive: false } });
    render(<MemberActiveToggle userId={TEACHER_ID} isActive={true} displayName="山田先生" />);

    // トグル押下では即送信せず確認ダイアログを開く。
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    expect(toggleMock).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("山田先生");

    // ダイアログの確定ボタンで送信。
    fireEvent.click(screen.getByRole("button", { name: "無効化する" }));
    await waitFor(() =>
      expect(toggleMock).toHaveBeenCalledWith({ userId: TEACHER_ID, isActive: false }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // 完了後はダイアログを閉じる。
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("確認ダイアログをキャンセルすると action を呼ばない", async () => {
    render(<MemberActiveToggle userId={TEACHER_ID} isActive={true} displayName="山田先生" />);
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(toggleMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("無効状態は「再有効化」を表示し、確認なしで isActive=true で呼ぶ", async () => {
    toggleMock.mockResolvedValue({ ok: true, data: { id: TEACHER_ID, isActive: true } });
    render(<MemberActiveToggle userId={TEACHER_ID} isActive={false} displayName="山田先生" />);
    fireEvent.click(screen.getByRole("button", { name: "再有効化" }));
    await waitFor(() =>
      expect(toggleMock).toHaveBeenCalledWith({ userId: TEACHER_ID, isActive: true }),
    );
    // 再有効化は確認ダイアログを出さない。
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("失敗時は error を表示し refresh しない", async () => {
    toggleMock.mockResolvedValue({
      ok: false,
      error: { code: "forbidden", message: "権限がありません。" },
    });
    render(<MemberActiveToggle userId={TEACHER_ID} isActive={true} displayName="山田先生" />);
    fireEvent.click(screen.getByRole("button", { name: "無効化" }));
    fireEvent.click(await screen.findByRole("button", { name: "無効化する" }));
    expect(await screen.findByText(/権限がありません/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
