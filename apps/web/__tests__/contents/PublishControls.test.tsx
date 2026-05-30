import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/contents/publish-actions", () => ({
  publishContentAction: vi.fn(),
  unpublishContentAction: vi.fn(),
}));

import { PublishControls } from "../../app/admin/contents/_components/PublishControls";
import { publishContentAction, unpublishContentAction } from "../../lib/contents/publish-actions";

const publishMock = vi.mocked(publishContentAction);
const unpublishMock = vi.mocked(unpublishContentAction);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PublishControls (F04 即公開 / 非公開)", () => {
  it("draft では「公開する」を表示し、publishContentAction を contentId で呼ぶ", async () => {
    publishMock.mockResolvedValue({ ok: true, data: { publishId: "p1", version: 1 } });
    render(<PublishControls contentId="c-1" status="draft" />);
    const btn = screen.getByRole("button", { name: "公開する" });
    fireEvent.click(btn);
    await waitFor(() => expect(publishMock).toHaveBeenCalledWith("c-1"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("published では「非公開にする」を表示し、unpublishContentAction を呼ぶ", async () => {
    unpublishMock.mockResolvedValue({ ok: true, data: { publishId: "p1" } });
    render(<PublishControls contentId="c-2" status="published" />);
    fireEvent.click(screen.getByRole("button", { name: "非公開にする" }));
    await waitFor(() => expect(unpublishMock).toHaveBeenCalledWith("c-2"));
  });

  it("失敗時は ActionResult.message を alert 表示し、refresh しない", async () => {
    publishMock.mockResolvedValue({
      ok: false,
      code: "not_found",
      message: "コンテンツが見つかりません。",
    });
    render(<PublishControls contentId="c-3" status="draft" />);
    fireEvent.click(screen.getByRole("button", { name: "公開する" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("コンテンツが見つかりません。");
    expect(refresh).not.toHaveBeenCalled();
  });
});
