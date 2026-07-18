import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MorningDraft } from "../../lib/editor/morning-draft-core";

/**
 * {@link MorningDraftCard}（朝ドラフト確定カード・P0・PR-Z3）を固定する。
 *
 * - 合成された予定 / 連絡を出所（provenance）バッジ付きで一覧すること
 * - × で項目を除外し、確定でそのキーだけを `confirmMorningDraftAction` へ渡すこと（D4: client は items を送らない）
 * - 成功で undo を CopyUndoContext（`forKey=date`）へ載せ、`?applied=<nonce>` 再ナビ（SeedConfirmButton と同型）が走ること
 * - 失敗時はナビゲーションも undo 登録もせずエラーを出すこと（半端な確定を「完了」に見せない）
 * - 全項目を除外すると確定ボタンが無効（サーバの空拒否を押す前に UI で防ぐ）
 */

const replaceMock = vi.hoisted(() => vi.fn());
const setUndoMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/app/editor/c1",
  useSearchParams: () => new URLSearchParams("date=2026-07-13"),
}));
vi.mock("../../lib/editor/morning-draft-actions", () => ({
  confirmMorningDraftAction: vi.fn(async () => ({
    ok: true,
    data: {
      date: "2026-07-13",
      sections: [{ block: "schedule", label: "予定", count: 2 }],
      undo: { date: "2026-07-13", schedule: [], notice: [] },
    },
  })),
}));
vi.mock("../../app/app/editor/[classId]/_components/CopyUndoContext", () => ({
  useCopyUndo: () => ({ undo: null, setUndo: setUndoMock }),
}));

import { MorningDraftCard } from "../../app/app/editor/[classId]/_components/MorningDraftCard";
import { confirmMorningDraftAction } from "../../lib/editor/morning-draft-actions";

const DRAFT: MorningDraft = {
  sections: {
    schedules: [
      {
        key: "schedules:timetable:0",
        provenance: "基本時間割",
        item: { period: 1, subject: "数学" },
      },
      { key: "schedules:event:e1", provenance: "年間行事", item: { subject: "終業式" } },
    ],
    notices: [{ key: "notices:event:e1", provenance: "年間行事", item: { text: "体育館に集合" } }],
  },
  provenance: [
    { section: "schedules", key: "schedules:timetable:0", provenance: "基本時間割" },
    { section: "schedules", key: "schedules:event:e1", provenance: "年間行事" },
    { section: "notices", key: "notices:event:e1", provenance: "年間行事" },
  ],
  isEmpty: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MorningDraftCard（朝ドラフト確定カード）", () => {
  it("合成内容を出所バッジ付きで一覧する（予定は時限+科目、連絡は本文）", () => {
    render(<MorningDraftCard classId="c1" date="2026-07-13" pattern="pattern1" draft={DRAFT} />);
    expect(screen.getByText("1限 数学")).toBeTruthy();
    expect(screen.getByText("終業式")).toBeTruthy();
    expect(screen.getByText("体育館に集合")).toBeTruthy();
    // 出所バッジ: 基本時間割 1 件 + 年間行事 2 件。
    expect(screen.getByText("基本時間割")).toBeTruthy();
    expect(screen.getAllByText("年間行事")).toHaveLength(2);
  });

  it("確定でサーバ再合成へ classId/date/除外キー（既定は空）を渡し、成功で undo 登録 + ?applied 再ナビ", async () => {
    render(<MorningDraftCard classId="c1" date="2026-07-13" pattern="pattern1" draft={DRAFT} />);

    fireEvent.click(screen.getByRole("button", { name: "この下書きで盤面に出す" }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    // client は items を送らない（D4）: classId / date / 除外キー配列のみ。
    expect(confirmMorningDraftAction).toHaveBeenCalledWith("c1", "2026-07-13", []);
    // undo を CopyUndoContext（forKey=date）へ載せる＝既存 CopyFromMenu の「元に戻す」が拾う。
    expect(setUndoMock).toHaveBeenCalledWith({
      classId: "c1",
      forKey: "2026-07-13",
      label: "今日の下書き",
      days: [{ date: "2026-07-13", schedule: [], notice: [] }],
    });
    const [url, opts] = replaceMock.mock.calls[0] as [string, { scroll: boolean }];
    const params = new URLSearchParams(url.split("?")[1]);
    expect(url.startsWith("/app/editor/c1?")).toBe(true);
    expect(params.get("date")).toBe("2026-07-13");
    expect(params.get("applied")).toMatch(/^\d+$/);
    expect(opts).toEqual({ scroll: false });
  });

  it("× で除外した項目のキーだけを確定時に渡す（残りは渡さない）", async () => {
    render(<MorningDraftCard classId="c1" date="2026-07-13" pattern="pattern1" draft={DRAFT} />);

    fireEvent.click(screen.getByRole("button", { name: "「終業式」を除外" }));
    fireEvent.click(screen.getByRole("button", { name: "この下書きで盤面に出す" }));

    await waitFor(() => expect(confirmMorningDraftAction).toHaveBeenCalledTimes(1));
    expect(confirmMorningDraftAction).toHaveBeenCalledWith("c1", "2026-07-13", [
      "schedules:event:e1",
    ]);
  });

  it("保存失敗時はナビゲーションも undo 登録もせずエラーを出す", async () => {
    vi.mocked(confirmMorningDraftAction).mockResolvedValueOnce({
      ok: false,
      error: { code: "invalid", message: "反映できる下書きがありません。" },
    } as never);
    render(<MorningDraftCard classId="c1" date="2026-07-13" pattern="pattern1" draft={DRAFT} />);

    fireEvent.click(screen.getByRole("button", { name: "この下書きで盤面に出す" }));

    await screen.findByText("反映できる下書きがありません。");
    expect(replaceMock).not.toHaveBeenCalled();
    expect(setUndoMock).not.toHaveBeenCalled();
  });

  it("全項目を除外すると確定ボタンが無効（空確定をUIで防ぐ）", () => {
    render(<MorningDraftCard classId="c1" date="2026-07-13" pattern="pattern1" draft={DRAFT} />);

    fireEvent.click(screen.getByRole("button", { name: "「1限 数学」を除外" }));
    fireEvent.click(screen.getByRole("button", { name: "「終業式」を除外" }));
    fireEvent.click(screen.getByRole("button", { name: "「体育館に集合」を除外" }));

    expect(screen.getByText("すべて除外されています")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "この下書きで盤面に出す" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
