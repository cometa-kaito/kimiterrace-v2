import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #48-L (#123): SchoolEditForm の**項目別インライン検証 (FormField)** + 既定値・更新経路。
 * updateSchoolAction と router を mock し、(1) 必須項目を空にして送信すると項目エラーで送信を止める
 * (2) 正常編集で id 付きで action を呼び成功メッセージを表示、を検証する。検証規則は schools-core.test.ts。
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/system-admin/schools-actions", () => ({
  updateSchoolAction: vi.fn(),
  setSchoolTeacherPasswordAction: vi.fn(),
  clearSchoolTeacherPasswordAction: vi.fn(),
}));

import { SchoolEditForm } from "../../app/admin/system/schools/[id]/edit/_components/SchoolEditForm";
import { updateSchoolAction } from "../../lib/system-admin/schools-actions";

const updateMock = vi.mocked(updateSchoolAction);
const SCHOOL = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "岐南工業高校",
  prefecture: "岐阜県",
  code: "G001",
  hierarchyMode: "department" as const,
  teacherLoginEnabled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("SchoolEditForm 項目別検証 + 更新", () => {
  it("既定値を埋め、必須を空にして送信すると項目エラーで送信を止める", () => {
    render(<SchoolEditForm school={SCHOOL} />);
    const name = screen.getByRole("textbox", { name: "学校名" });
    expect(name).toHaveValue("岐南工業高校"); // defaultValue
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "更新する" }));
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.getByText(/学校名は 1〜200 文字/)).toBeInTheDocument();
  });

  it("正常編集で id 付きで updateSchoolAction を呼び、成功メッセージを表示する", async () => {
    updateMock.mockResolvedValue({ ok: true, data: { id: SCHOOL.id } });
    render(<SchoolEditForm school={SCHOOL} />);
    fireEvent.change(screen.getByRole("textbox", { name: "学校名" }), {
      target: { value: "岐南工業高等学校" },
    });
    fireEvent.click(screen.getByRole("button", { name: "更新する" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        id: SCHOOL.id,
        name: "岐南工業高等学校",
        prefecture: "岐阜県",
        code: "G001",
        hierarchyMode: "department",
      }),
    );
    expect(await screen.findByText("学校情報を更新しました。")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });
});
