import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324, ADR-026 D2): StaffRoleToggle のテスト。changeStaffRoleAction と router を mock し、
 * 変更先ロールのラベル表示・confirm 後に反対ロールで action を呼ぶこと・キャンセルで未送信・失敗
 * (唯一の有効な学校管理者の降格など) の表示を検証。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/users-actions", () => ({ changeStaffRoleAction: vi.fn() }));

import { StaffRoleToggle } from "../../app/admin/system/users/_components/StaffRoleToggle";
import { changeStaffRoleAction } from "../../lib/system-admin/users-actions";

const changeMock = vi.mocked(changeStaffRoleAction);
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("StaffRoleToggle (#324 D2 ロール変更トグル)", () => {
  it("teacher 行は「学校管理者に変更」を表示し、confirm 後に nextRole=school_admin で呼ぶ → refresh", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    changeMock.mockResolvedValue({ ok: true, data: { id: USER_ID, role: "school_admin" } });
    render(
      <StaffRoleToggle
        userId={USER_ID}
        currentRole="teacher"
        displayName="山田先生"
        schoolName="テスト高校 A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "学校管理者に変更" }));
    await waitFor(() =>
      expect(changeMock).toHaveBeenCalledWith({ userId: USER_ID, nextRole: "school_admin" }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("school_admin 行は「教員に変更」を表示し、confirm 後に nextRole=teacher で呼ぶ", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    changeMock.mockResolvedValue({ ok: true, data: { id: USER_ID, role: "teacher" } });
    render(
      <StaffRoleToggle
        userId={USER_ID}
        currentRole="school_admin"
        displayName="管理者A"
        schoolName="テスト高校 A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "教員に変更" }));
    await waitFor(() =>
      expect(changeMock).toHaveBeenCalledWith({ userId: USER_ID, nextRole: "teacher" }),
    );
  });

  it("confirm キャンセルすると action を呼ばない (ロール変更は常に確認する)", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <StaffRoleToggle
        userId={USER_ID}
        currentRole="teacher"
        displayName="山田先生"
        schoolName="テスト高校 A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "学校管理者に変更" }));
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("失敗時 (last-admin 降格など) は error を表示し refresh しない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    changeMock.mockResolvedValue({
      ok: false,
      error: {
        code: "conflict",
        message: "この学校で唯一の有効な学校管理者のため教員に変更できません。",
      },
    });
    render(
      <StaffRoleToggle
        userId={USER_ID}
        currentRole="school_admin"
        displayName="管理者A"
        schoolName="テスト高校 A"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "教員に変更" }));
    expect(await screen.findByText(/唯一の有効な学校管理者/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
