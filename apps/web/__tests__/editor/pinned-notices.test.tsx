import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR-C 固定行（設計書 editor-restructure-bulletin-2026-07.md §5.4）のエディタ挙動を固定する。
 *
 * - **「ずっと（固定表示）」select**: NoticeEditor の表示日数 select の独立 option（値 "pinned"）。選ぶと
 *   既存の自動保存経路で `pinned: true` として保存され、displayDays は保存されない（排他）。divider 行にも
 *   同じ選択肢が出る（「区切り線ごと固定」）。
 * - **「固定中のお知らせ」一覧（PinnedNoticesList）**: 対象日以外の日に入力された pinned 行は連絡エディタに
 *   出てこない幽霊になるため、入力日つき一覧＋削除（＝入力日の行の**置換保存**・既存 setNoticesAction）を
 *   提供する（受入基準 PR-C-2）。対象日の行は上のエディタに見えるので一覧から除く。
 * - **「ずっと」はクラスエディタ限定（`allowPinned`・2026-07-04 Reviewer HIGH-1）**: 削除導線
 *   （PinnedNoticesList）が無い scope（学校/学科/学年）・ops エディタには option 自体を出さない
 *   （既存 pinned 行の表示・解除だけ fail-soft で可能）。
 *
 * Server Action は import 時に DB/認可を引き込むため mock（freedom-basics.test.tsx と同作法）。
 */

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  setNoticesAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { id: "x" } })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: h.refresh }),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: vi.fn(),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.setNoticesAction(...a),
  setAssignmentsAction: vi.fn(),
}));

import { NoticeEditor } from "../../app/app/editor/[classId]/_components/NoticeEditor";
import { PinnedNoticesList } from "../../app/app/editor/[classId]/_components/PinnedNoticesList";
import type { NoticeItem } from "../../lib/editor/notice-assignment-core";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-07-06";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** debounce された自動保存を確実に発火させる。 */
async function flushAutoSave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

function lastSaved(): NoticeItem[] {
  const call = h.setNoticesAction.mock.calls.at(-1) as unknown[];
  return call[3] as NoticeItem[];
}

describe("NoticeEditor 「ずっと（固定表示）」select（§5.4）", () => {
  it("表示日数 select で「ずっと」を選ぶと pinned:true で保存され displayDays は保存されない（排他）", async () => {
    // displayDays:3 の行 → 詳細は初期から開いている（設定済みを隠さない）。
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ text: "校訓", displayDays: 3 }]}
        allowPinned
      />,
    );
    act(() => {
      fireEvent.change(screen.getByLabelText("1 件目の表示日数"), { target: { value: "pinned" } });
    });
    await flushAutoSave();
    expect(h.setNoticesAction).toHaveBeenCalled();
    expect(lastSaved()).toEqual([{ text: "校訓", pinned: true }]);
  });

  it("pinned の行はロード時に「ずっと」が選択されており、プリセットへ戻すと displayDays 保存に戻る", async () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ text: "校訓", pinned: true }]}
        allowPinned
      />,
    );
    const select = screen.getByLabelText("1 件目の表示日数") as HTMLSelectElement;
    expect(select.value).toBe("pinned");
    act(() => {
      fireEvent.change(select, { target: { value: "3" } });
    });
    await flushAutoSave();
    expect(lastSaved()).toEqual([{ text: "校訓", displayDays: 3 }]);
  });

  it("divider 行にも「ずっと」を選べる（区切り線ごと固定・§5.4）", async () => {
    // divider（既定値のみ）→ 詳細は畳まれているのでトグルで開いてから選ぶ。
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ kind: "divider", text: "校訓" }]}
        allowPinned
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "1 件目の詳細項目" }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("1 件目の表示日数"), { target: { value: "pinned" } });
    });
    await flushAutoSave();
    expect(lastSaved()).toEqual([{ kind: "divider", text: "校訓", pinned: true }]);
  });

  it("「ずっと」選択中はカスタム日数入力を出さない（displayDays と排他）", () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ text: "校訓", displayDays: 5 }]}
        allowPinned
      />,
    );
    // displayDays:5 はプリセット外＝カスタム入力が出ている。
    expect(screen.getByLabelText("1 件目の表示日数 (日)")).toBeTruthy();
    act(() => {
      fireEvent.change(screen.getByLabelText("1 件目の表示日数"), { target: { value: "pinned" } });
    });
    expect(screen.queryByLabelText("1 件目の表示日数 (日)")).toBeNull();
  });
});

describe("「ずっと」のクラス scope 限定（HIGH-1・allowPinned 出し分け）", () => {
  it("allowPinned 無し（scope/ops エディタ既定）では「ずっと（固定表示）」option を出さない", () => {
    // scope（学校全体）エディタ相当。displayDays:3 → 詳細は初期から開いている。
    render(
      <NoticeEditor
        target={{ scope: "school" }}
        date={DATE}
        initialItems={[{ text: "学校からの連絡", displayDays: 3 }]}
      />,
    );
    const select = screen.getByLabelText("1 件目の表示日数") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain("pinned");
    expect(screen.queryByText("ずっと（固定表示）")).toBeNull();
  });

  it("allowPinned 無しでも既存 pinned 行は「ずっと」を表示・解除できる（fail-soft）", async () => {
    // 旧データに pinned が残っている scope/ops エディタ相当。現在値の表示と解除だけは可能にする。
    render(
      <NoticeEditor
        target={{ scope: "school" }}
        date={DATE}
        initialItems={[{ text: "旧データの固定", pinned: true }]}
      />,
    );
    const select = screen.getByLabelText("1 件目の表示日数") as HTMLSelectElement;
    expect(select.value).toBe("pinned");
    // 解除（プリセットへ変更）すると option ごと消え、以後は選び直せない。
    act(() => {
      fireEvent.change(select, { target: { value: "3" } });
    });
    await flushAutoSave();
    expect(lastSaved()).toEqual([{ text: "旧データの固定", displayDays: 3 }]);
    expect(Array.from(select.options).map((o) => o.value)).not.toContain("pinned");
  });

  it("allowPinned（クラスエディタ）では新規行にも「ずっと」option が出る", () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ text: "連絡", displayDays: 3 }]}
        allowPinned
      />,
    );
    const select = screen.getByLabelText("1 件目の表示日数") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain("pinned");
  });
});

describe("PinnedNoticesList 「固定中のお知らせ」（§5.4・受入基準 PR-C-2）", () => {
  const rows = [
    {
      date: "2026-07-01",
      items: [
        { text: "通常の連絡" },
        { kind: "divider" as const, text: "校訓", pinned: true },
        { text: "礼儀正しく 勤労を尊び", pinned: true },
      ],
    },
    { date: DATE, items: [{ text: "対象日の固定", pinned: true }] },
  ];

  it("対象日以外の pinned 項目だけを入力日つきで一覧する（対象日の行は上のエディタが担う）", () => {
    render(<PinnedNoticesList classId={CLASS_ID} currentDate={DATE} rows={rows} />);
    expect(screen.getByRole("heading", { name: "固定中のお知らせ" })).toBeTruthy();
    expect(screen.getByText("── 校訓 ──")).toBeTruthy();
    expect(screen.getByText("礼儀正しく 勤労を尊び")).toBeTruthy();
    expect(screen.getAllByText("7月1日 から")).toHaveLength(2);
    // 対象日の pinned・pinned でない項目は出さない。
    expect(screen.queryByText("対象日の固定")).toBeNull();
    expect(screen.queryByText("通常の連絡")).toBeNull();
  });

  it("削除＝入力日の行から当該項目を除いた置換保存（既存 setNoticesAction）→ refresh", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PinnedNoticesList classId={CLASS_ID} currentDate={DATE} rows={rows} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "固定中のお知らせ 2 件目を削除" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.setNoticesAction).toHaveBeenCalledTimes(1);
    // 「礼儀正しく…」(行内 index 2) を除いた残り全件で 2026-07-01 の行を置換する。
    expect(h.setNoticesAction).toHaveBeenCalledWith(
      "class",
      CLASS_ID,
      "2026-07-01",
      [{ text: "通常の連絡" }, { kind: "divider", text: "校訓", pinned: true }],
      undefined,
    );
    expect(h.refresh).toHaveBeenCalled();
  });

  it("confirm キャンセルなら何も保存しない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PinnedNoticesList classId={CLASS_ID} currentDate={DATE} rows={rows} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "固定中のお知らせ 1 件目を削除" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.setNoticesAction).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("固定中が 1 件も無ければ何も描画しない（対象日の pinned のみでも同様）", () => {
    const { container } = render(
      <PinnedNoticesList
        classId={CLASS_ID}
        currentDate={DATE}
        rows={[{ date: DATE, items: [{ text: "対象日の固定", pinned: true }] }]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("保存失敗はエラーを表示し refresh しない", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    h.setNoticesAction.mockResolvedValueOnce({
      ok: false,
      error: { code: "conflict", message: "他の操作と競合しました。" },
    } as never);
    render(<PinnedNoticesList classId={CLASS_ID} currentDate={DATE} rows={rows} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "固定中のお知らせ 1 件目を削除" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert").textContent).toContain("競合");
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
