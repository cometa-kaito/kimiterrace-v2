import type { ContentVersionInfo } from "@kimiterrace/db";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/contents/publish-actions", () => ({ rollbackContentAction: vi.fn() }));

import { VersionTimeline } from "../../app/app/contents/_components/VersionTimeline";
import { rollbackContentAction } from "../../lib/contents/publish-actions";

const rollbackMock = vi.mocked(rollbackContentAction);

function v(id: string, version: number, diffSummary: string | null = null): ContentVersionInfo {
  return { id, version, diffSummary, createdAt: new Date("2026-05-30T00:00:00Z"), createdBy: "u1" };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VersionTimeline (F04.2 1-click rollback)", () => {
  it("空履歴では案内文を出す", () => {
    render(<VersionTimeline contentId="c-1" versions={[]} activeVersionId={null} />);
    expect(screen.getByText(/まだバージョン履歴がありません/)).toBeInTheDocument();
  });

  it("最新 (先頭) には rollback ボタンを出さず「最新」タグ、公開中版に「公開中」タグ", () => {
    const versions = [v("v3", 3), v("v2", 2), v("v1", 1)];
    render(<VersionTimeline contentId="c-1" versions={versions} activeVersionId="v1" />);
    expect(screen.getByText("最新")).toBeInTheDocument();
    expect(screen.getByText("公開中")).toBeInTheDocument();
    // rollback ボタンは v2 / v1 の 2 つ (最新 v3 には無い)
    expect(screen.getAllByRole("button", { name: "このバージョンに戻す" })).toHaveLength(2);
  });

  it("rollback ボタンで rollbackContentAction(contentId, version) を呼び、成功で refresh", async () => {
    rollbackMock.mockResolvedValue({ ok: true, data: { version: 4, restoredFrom: 2 } });
    const versions = [v("v3", 3), v("v2", 2)];
    render(<VersionTimeline contentId="c-9" versions={versions} activeVersionId={null} />);
    // v2 の rollback (最新 v3 以外は 1 つ)
    fireEvent.click(screen.getByRole("button", { name: "このバージョンに戻す" }));
    await waitFor(() => expect(rollbackMock).toHaveBeenCalledWith("c-9", 2));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("失敗時は alert を表示し refresh しない", async () => {
    rollbackMock.mockResolvedValue({
      ok: false,
      code: "version_not_found",
      message: "指定したバージョンが存在しません。",
    });
    render(
      <VersionTimeline
        contentId="c-9"
        versions={[v("v3", 3), v("v2", 2)]}
        activeVersionId={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "このバージョンに戻す" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "指定したバージョンが存在しません。",
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
