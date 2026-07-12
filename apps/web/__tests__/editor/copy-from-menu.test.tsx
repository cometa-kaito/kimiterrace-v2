import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 「ほかの日からコピー」統合ツール（CopyFromMenu）の UX 契約を固定する。プレビュー・保存・監査・RLS・週割りは
 * Server Action（mock）。ここで守るのは:
 * - コピー元選択（前営業日 / 先週の同じ曜日 / 任意日 / 先週まるごと）と、押す前のプレビュー取得。
 * - コピー先は**編集中の日付**（週コピーも編集中日付の週の anchor で呼ぶ＝旧「今日固定」の罠の回帰ガード）。
 * - 対象に既存入力がある / 週コピーは **ConfirmDialog（on-brand 確認）** を挟み、キャンセルなら action を呼ばない。
 * - 成功時は `?copied=<nonce>` + `date=` を付けた `router.replace` で再ナビゲート（`router.refresh` は使わない＝
 *   配下エディタの useState(initial…) が残り反映されない旧 Reviewer HIGH と同じ回帰ガード）。
 */

const h = vi.hoisted(() => ({
  copyDay: vi.fn(
    async (
      ..._a: unknown[]
    ): Promise<
      | {
          ok: true;
          data: {
            fromDate: string;
            sections: { block: string; label: string; count: number }[];
            undo: { date: string; [k: string]: unknown };
          };
        }
      | { ok: false; error: { code: string; message: string } }
    > => ({
      ok: true,
      data: {
        fromDate: "2026-07-03",
        sections: [
          { block: "schedule", label: "予定", count: 4 },
          { block: "notice", label: "連絡", count: 2 },
        ],
        undo: { date: "2026-07-06", schedule: [], notice: [] },
      },
    }),
  ),
  copyWeek: vi.fn(async (..._a: unknown[]) => ({
    ok: true as const,
    data: {
      fromWeekStart: "2026-06-29",
      toWeekStart: "2026-07-06",
      daysCopied: 3,
      undo: [{ date: "2026-07-06", schedule: [] }],
    },
  })),
  restore: vi.fn(async (..._a: unknown[]) => ({
    ok: true as const,
    data: { daysRestored: 1 },
  })),
  previewDay: vi.fn(async (..._a: unknown[]) => ({
    ok: true as const,
    data: {
      fromDate: "2026-07-03",
      sections: [
        { block: "schedule", label: "予定", count: 4 },
        { block: "notice", label: "連絡", count: 2 },
      ],
      total: 6,
    },
  })),
  previewWeek: vi.fn(async (..._a: unknown[]) => ({
    ok: true as const,
    data: { fromWeekStart: "2026-06-29", toWeekStart: "2026-07-06", nonEmptyDays: 3, total: 9 },
  })),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh, push: vi.fn() }),
  usePathname: () => "/app/editor/11111111-1111-1111-1111-111111111111",
  useSearchParams: () => new URLSearchParams("date=2026-07-06"),
}));
vi.mock("@/lib/editor/copy-day-actions", () => ({
  copyDayFromAction: (...a: unknown[]) => h.copyDay(...a),
  copyPreviousWeekAction: (...a: unknown[]) => h.copyWeek(...a),
  previewCopyDayAction: (...a: unknown[]) => h.previewDay(...a),
  previewCopyWeekAction: (...a: unknown[]) => h.previewWeek(...a),
  restoreCopySnapshotAction: (...a: unknown[]) => h.restore(...a),
}));

import { CopyFromMenu } from "../../app/app/editor/[classId]/_components/CopyFromMenu";
import { CopyUndoProvider } from "../../app/app/editor/[classId]/_components/CopyUndoContext";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
// 2026-07-06 は月曜。前営業日 = 2026-07-03（金）。この週 = 07-06〜07-10。先週 = 06-29〜07-03。
const DATE = "2026-07-06";

/** CopyFromMenu は useCopyUndo を使うので Provider で包む（page.tsx と同じ構造）。 */
function renderMenu(hasExistingData: boolean) {
  return render(
    <CopyUndoProvider>
      <CopyFromMenu classId={CLASS_ID} date={DATE} hasExistingData={hasExistingData} />
    </CopyUndoProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "ほかの日からコピー" }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CopyFromMenu（ほかの日からコピー 統合ツール）", () => {
  it("開くと既定=前営業日でプレビューを取得し、既存入力なしなら確認なしでコピー→?copied+date 付き replace（refresh は使わない）", async () => {
    await act(async () => {
      renderMenu(false);
    });
    await act(async () => {
      openMenu();
    });
    // 既定選択（前営業日 = 2026-07-03）でプレビューを取得している。
    expect(h.previewDay).toHaveBeenCalledWith(CLASS_ID, "2026-07-03");
    expect(await screen.findByText(/コピー元の内容/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));
    });
    // 既存入力なし → 確認ダイアログを挟まず直接コピー。コピー先は編集中の日付。
    expect(h.copyDay).toHaveBeenCalledWith(CLASS_ID, "2026-07-03", DATE);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledTimes(1);
    const [url, opts] = h.replace.mock.calls[0] as [string, { scroll?: boolean }];
    expect(url).toContain("date=2026-07-06");
    expect(url).toMatch(/copied=\d+/);
    expect(opts).toEqual({ scroll: false });
  });

  it("対象日に既存入力があると ConfirmDialog を挟み、確認するまで action を呼ばない", async () => {
    await act(async () => {
      renderMenu(true);
    });
    await act(async () => {
      openMenu();
    });
    await screen.findByText(/コピー元の内容/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));
    });
    // まだコピーしていない（確認待ち）。
    expect(h.copyDay).not.toHaveBeenCalled();
    expect(screen.getByText("今の内容を置き換えますか？")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "置き換えてコピー" }));
    });
    expect(h.copyDay).toHaveBeenCalledWith(CLASS_ID, "2026-07-03", DATE);
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it("確認をキャンセルすると action を呼ばない（誤上書き防止）", async () => {
    await act(async () => {
      renderMenu(true);
    });
    await act(async () => {
      openMenu();
    });
    await screen.findByText(/コピー元の内容/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    });
    expect(h.copyDay).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("先週まるごと=編集中日付の週の anchor で週プレビュー→常に確認→前週コピー（旧『今日固定』の是正）", async () => {
    await act(async () => {
      renderMenu(false);
    });
    await act(async () => {
      openMenu();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /先週まるごと/ }));
    });
    // 週プレビューは編集中の日付を anchor に呼ぶ（今日ではない）。
    expect(h.previewWeek).toHaveBeenCalledWith(CLASS_ID, DATE);
    await screen.findByText(/同じ曜日へ/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));
    });
    // 週コピーは常に上書き確認。
    expect(h.copyWeek).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "置き換えてコピー" }));
    });
    // 前週コピーも編集中の日付を anchor に呼ぶ（＝この週へ入る）。
    expect(h.copyWeek).toHaveBeenCalledWith(CLASS_ID, DATE);
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it("任意の日を選ぶと、その日を fromDate にコピーする", async () => {
    await act(async () => {
      renderMenu(false);
    });
    await act(async () => {
      openMenu();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("コピー元の日付"), {
        target: { value: "2026-06-15" },
      });
    });
    expect(h.previewDay).toHaveBeenCalledWith(CLASS_ID, "2026-06-15");
    await screen.findByText(/コピー元の内容/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));
    });
    expect(h.copyDay).toHaveBeenCalledWith(CLASS_ID, "2026-06-15", DATE);
  });

  it("コピー元に内容が無いときは『コピーする』を押せない（空で対象日を潰さない）", async () => {
    h.previewDay.mockResolvedValueOnce({
      ok: true as const,
      data: {
        fromDate: "2026-07-03",
        sections: [{ block: "schedule", label: "予定", count: 0 }],
        total: 0,
      },
    });
    await act(async () => {
      renderMenu(false);
    });
    await act(async () => {
      openMenu();
    });
    expect(await screen.findByText("この日には内容がありません。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "コピーする" })).toBeDisabled();
  });

  it("action 失敗時はエラーメッセージを出し、再ナビゲートしない", async () => {
    h.copyDay.mockResolvedValueOnce({
      ok: false,
      error: { code: "invalid", message: "コピー元（2026-07-03）に複製できる予定がありません。" },
    });
    await act(async () => {
      renderMenu(false);
    });
    await act(async () => {
      openMenu();
    });
    await screen.findByText(/コピー元の内容/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));
    });
    expect(await screen.findByText(/複製できる予定がありません/)).toBeInTheDocument();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("コピー成功後に『元に戻す』が出て、確認後にコピー前スナップショットで復元し再ナビゲートする", async () => {
    await act(async () => {
      renderMenu(false);
    });
    await act(async () => {
      openMenu();
    });
    await screen.findByText(/コピー元の内容/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "コピーする" }));
    });
    // コピー成功で undo が保持され、同じ日を表示中なので「元に戻す」チップが出る（aria-label で confirm と区別）。
    const undoChip = await screen.findByRole("button", { name: /コピーを元に戻す/ });
    await act(async () => {
      fireEvent.click(undoChip);
    });
    // チップは確認を挟む（コピー後の手直しを黙って巻き戻さない）。押しただけでは復元しない。
    expect(h.restore).not.toHaveBeenCalled();
    expect(screen.getByText("コピー前の状態に戻しますか？")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    });
    // 復元はコピー action が返した undo スナップショット（days）をそのまま渡す。
    expect(h.restore).toHaveBeenCalledWith(CLASS_ID, [
      { date: "2026-07-06", schedule: [], notice: [] },
    ]);
    // コピー(1) + 復元(1) で 2 回再ナビゲート。
    expect(h.replace).toHaveBeenCalledTimes(2);
  });

  it("コピー前は『元に戻す』を出さない", async () => {
    await act(async () => {
      renderMenu(false);
    });
    expect(screen.queryByRole("button", { name: /元に戻す/ })).not.toBeInTheDocument();
  });
});
