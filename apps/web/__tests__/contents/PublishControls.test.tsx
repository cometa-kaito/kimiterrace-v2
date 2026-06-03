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
  it("draft では「公開する」を表示し、publishContentAction を contentId で呼ぶ (override なし)", async () => {
    publishMock.mockResolvedValue({ ok: true, data: { publishId: "p1", version: 1 } });
    render(<PublishControls contentId="c-1" status="draft" />);
    const btn = screen.getByRole("button", { name: "公開する" });
    fireEvent.click(btn);
    // 初回公開は acknowledgePii 未指定 (undefined)。
    await waitFor(() => expect(publishMock).toHaveBeenCalledWith("c-1", undefined));
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

  describe("PII soft-gate (ADR-030, #426)", () => {
    it("pii_warning を受けると警告と疑わしい箇所を表示し、公開せず override ボタンを出す", async () => {
      publishMock.mockResolvedValue({
        ok: false,
        code: "pii_warning",
        message: "個人名らしき表現が含まれています。",
        suspects: ["田中さん"],
      });
      render(<PublishControls contentId="c-4" status="draft" />);
      fireEvent.click(screen.getByRole("button", { name: "公開する" }));
      expect(await screen.findByText(/個人名らしき表現が含まれています/)).toBeInTheDocument();
      expect(screen.getByText(/田中さん/)).toBeInTheDocument();
      // 公開トランジションが pending の間は override ボタンの表示が "処理中…" になり
      // アクセシブル名が "承知の上で公開する" でないため getByRole が落ちる (flaky の原因、#553)。
      // findByRole で settle (名前が確定) するまで待つ。
      expect(await screen.findByRole("button", { name: "承知の上で公開する" })).toBeInTheDocument();
      expect(refresh).not.toHaveBeenCalled();
    });

    it("「承知の上で公開する」は acknowledgePii=true で再送し、成功で refresh する", async () => {
      publishMock
        .mockResolvedValueOnce({
          ok: false,
          code: "pii_warning",
          message: "個人名らしき表現が含まれています。",
          suspects: ["田中さん"],
        })
        .mockResolvedValueOnce({ ok: true, data: { publishId: "p9", version: 2 } });
      render(<PublishControls contentId="c-5" status="draft" />);
      fireEvent.click(screen.getByRole("button", { name: "公開する" }));
      const overrideBtn = await screen.findByRole("button", { name: "承知の上で公開する" });
      // 公開トランジションが settle (ボタン enabled) してからクリックする。pending 中は
      // disabled でクリックが no-op になり override が再送されない (flaky の原因、#553)。
      await waitFor(() => expect(overrideBtn).toBeEnabled());
      fireEvent.click(overrideBtn);
      await waitFor(() =>
        expect(publishMock).toHaveBeenLastCalledWith("c-5", { acknowledgePii: true }),
      );
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("「編集に戻る」で警告を閉じる (公開しない)", async () => {
      publishMock.mockResolvedValue({
        ok: false,
        code: "pii_warning",
        message: "個人名らしき表現が含まれています。",
        suspects: ["田中さん"],
      });
      render(<PublishControls contentId="c-6" status="draft" />);
      fireEvent.click(screen.getByRole("button", { name: "公開する" }));
      const backBtn = await screen.findByRole("button", { name: "編集に戻る" });
      // 公開トランジションが settle (ボタン enabled) してからクリックする。pending 中は
      // disabled でクリックが no-op になり、警告が閉じず waitFor がタイムアウトしていた
      // (flaky の根因、#553)。setPiiSuspects(null) は onClick 直結の同期更新で act() 内に
      // flush されるため、enabled で確実にクリックできれば消失は即時 = 待機不要。
      await waitFor(() => expect(backBtn).toBeEnabled());
      fireEvent.click(backBtn);
      expect(screen.queryByText(/個人名らしき表現が含まれています/)).not.toBeInTheDocument();
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});
