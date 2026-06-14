import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #246 Low-2: SchoolDeleteButton の校名タイプ確認 UX。next/navigation と deleteSchoolAction を mock。
 * 校名を正確に入力するまで実行ボタンが無効であること (誤操作防止) と、一致後に id 付きで action を呼ぶ
 * ことを検証する。
 */

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/system-admin/schools-actions", () => ({ deleteSchoolAction: vi.fn() }));

import { SchoolDeleteButton } from "../../app/ops/schools/[id]/_components/SchoolDeleteButton";
import { deleteSchoolAction } from "../../lib/system-admin/schools-actions";

const deleteMock = vi.mocked(deleteSchoolAction);
const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_NAME = "岐南工業高校";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SchoolDeleteButton (#246 Low-2 タイプ確認)", () => {
  it("初期は確認パネルを開かず、action を呼ばない", () => {
    render(<SchoolDeleteButton schoolId={SCHOOL_ID} schoolName={SCHOOL_NAME} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("校名不一致では実行ボタンが無効で action を呼べない", () => {
    render(<SchoolDeleteButton schoolId={SCHOOL_ID} schoolName={SCHOOL_NAME} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "別の学校" } });
    const confirmBtn = screen.getByRole("button", { name: "削除する" });
    expect(confirmBtn).toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("校名一致で実行ボタンが有効化され、id 付きで action を呼び成功時に一覧へ push する", async () => {
    deleteMock.mockResolvedValue({ ok: true, data: { id: SCHOOL_ID } });
    render(<SchoolDeleteButton schoolId={SCHOOL_ID} schoolName={SCHOOL_NAME} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: SCHOOL_NAME } });
    const confirmBtn = screen.getByRole("button", { name: "削除する" });
    expect(confirmBtn).toBeEnabled();
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith({ id: SCHOOL_ID }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/ops/schools"));
    expect(refresh).toHaveBeenCalled();
  });

  it("前後空白は許容して一致と見なす", async () => {
    deleteMock.mockResolvedValue({ ok: true, data: { id: SCHOOL_ID } });
    render(<SchoolDeleteButton schoolId={SCHOOL_ID} schoolName={SCHOOL_NAME} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `  ${SCHOOL_NAME}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith({ id: SCHOOL_ID }));
  });

  it("失敗時は error を表示し、push しない", async () => {
    deleteMock.mockResolvedValue({
      ok: false,
      error: {
        code: "conflict",
        message: "学年・クラス・コンテンツ等の関連データが存在するため削除できません。",
      },
    });
    render(<SchoolDeleteButton schoolId={SCHOOL_ID} schoolName={SCHOOL_NAME} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: SCHOOL_NAME } });
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    expect(await screen.findByText(/関連データが存在するため削除できません/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("キャンセルで確認パネルを閉じる", () => {
    render(<SchoolDeleteButton schoolId={SCHOOL_ID} schoolName={SCHOOL_NAME} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "削除" })).toBeInTheDocument();
  });
});
