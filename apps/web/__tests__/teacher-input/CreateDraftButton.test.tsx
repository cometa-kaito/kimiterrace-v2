import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** F01/F02 (#509 S3b) CreateDraftButton: 成功で editor へ遷移、失敗でメッセージ表示。 */

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const actionMock = vi.fn();
vi.mock("@/lib/teacher-input/draft-actions", () => ({
  createDraftFromInputAction: (id: string) => actionMock(id),
}));

import { CreateDraftButton } from "../../app/admin/teacher-input/_components/CreateDraftButton";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreateDraftButton", () => {
  it("成功すると /admin/contents/{contentId} へ push する", async () => {
    actionMock.mockResolvedValue({ ok: true, contentId: "content-9" });
    render(<CreateDraftButton inputId="ti-1" />);
    fireEvent.click(screen.getByRole("button", { name: "編集して公開" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/contents/content-9"));
    expect(actionMock).toHaveBeenCalledWith("ti-1");
  });

  it("失敗するとメッセージを表示し push しない", async () => {
    actionMock.mockResolvedValue({
      ok: false,
      code: "no_transcript",
      message: "本文が空のため下書きを作成できません。",
    });
    render(<CreateDraftButton inputId="ti-1" />);
    fireEvent.click(screen.getByRole("button", { name: "編集して公開" }));
    await waitFor(() => screen.getByText("本文が空のため下書きを作成できません。"));
    expect(push).not.toHaveBeenCalled();
  });
});
