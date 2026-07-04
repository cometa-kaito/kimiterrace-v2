import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 対象日セグメント（{@link EditorDateSegments}・editor-restructure-bulletin-2026-07.md §3.1）の描画・
 * 遷移テスト。単一編集スタックの対象日切替（受入基準 PR-A-3）を固定する:
 * - 時系列順（今日 → 翌授業日バッジ → …）＋「📅 ほかの日」。
 * - 選択中は aria-current=date。クリックは `?date=` ソフトナビ（scroll:false）。
 * - 選択中セグメントの再クリックは再ナビしない。
 * - カレンダーで選んだセグメント外の日は追加チップとして時系列位置に出す。
 * - 📅 は計画ゾーンの月カレンダー（{@link EDITOR_CALENDAR_ANCHOR_ID}）へスクロールする。
 */

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
}));

import { EditorDateSegments } from "../../app/app/editor/[classId]/_components/EditorDateSegments";
import { EDITOR_CALENDAR_ANCHOR_ID } from "../../app/app/editor/[classId]/_components/editor-anchors";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
// 2026-07-04 は土曜。セグメント列は [土(今日), 月, 火, 水]（サーバの editorDateSegments が決定）。
const TODAY = "2026-07-04";
const SEGMENTS = ["2026-07-04", "2026-07-06", "2026-07-07", "2026-07-08"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EditorDateSegments", () => {
  it("今日ラベル・翌授業日バッジ付きで時系列に並び、選択中に aria-current=date を付ける", () => {
    render(
      <EditorDateSegments
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-07-06"
        segmentDates={SEGMENTS}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "対象日" });
    expect(nav).toBeTruthy();
    // 今日（土）が先頭・「今日」の表記付き。
    expect(screen.getByRole("button", { name: "7/4（土）・今日を編集" })).toBeTruthy();
    // 翌授業日（月）にバッジ・選択中なので aria-current=date。
    const next = screen.getByRole("button", { name: "7/6（月）・翌授業日を編集" });
    expect(next.getAttribute("aria-current")).toBe("date");
    // 残りの授業日と 📅。
    expect(screen.getByRole("button", { name: "7/7（火）を編集" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "7/8（水）を編集" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "ほかの日を選ぶ（月カレンダーを開く）" }),
    ).toBeTruthy();
    // 選択は 1 つだけ。
    expect(
      screen.getByRole("button", { name: "7/4（土）・今日を編集" }).getAttribute("aria-current"),
    ).toBe(null);
  });

  it("セグメントクリックで ?date= へソフトナビする（scroll:false）", () => {
    render(
      <EditorDateSegments
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-07-04"
        segmentDates={SEGMENTS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "7/6（月）・翌授業日を編集" }));
    expect(h.push).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}?date=2026-07-06`, {
      scroll: false,
    });
  });

  it("選択中セグメントの再クリックは再ナビしない（入力中の編集を無駄に再マウントさせない）", () => {
    render(
      <EditorDateSegments
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-07-06"
        segmentDates={SEGMENTS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "7/6（月）・翌授業日を編集" }));
    expect(h.push).not.toHaveBeenCalled();
  });

  it("カレンダーで選んだセグメント外の日は追加チップとして時系列位置に出す（編集中の日は必ず行に見える）", () => {
    render(
      <EditorDateSegments
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-07-21"
        segmentDates={SEGMENTS}
      />,
    );
    const extra = screen.getByRole("button", { name: "7/21（火）を編集" });
    expect(extra.getAttribute("aria-current")).toBe("date");
    // 時系列順（既存セグメントの後ろ・📅 の前）に並ぶ。
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((l) => l?.endsWith("を編集"));
    expect(labels).toEqual([
      "7/4（土）・今日を編集",
      "7/6（月）・翌授業日を編集",
      "7/7（火）を編集",
      "7/8（水）を編集",
      "7/21（火）を編集",
    ]);
  });

  it("「📅 ほかの日」は計画ゾーンの月カレンダーへスクロールする（ナビはしない）", () => {
    const scrollSpy = vi.fn();
    const orig = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;
    const anchor = document.createElement("div");
    anchor.id = EDITOR_CALENDAR_ANCHOR_ID;
    document.body.appendChild(anchor);
    try {
      render(
        <EditorDateSegments
          classId={CLASS_ID}
          today={TODAY}
          selectedDate="2026-07-04"
          segmentDates={SEGMENTS}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "ほかの日を選ぶ（月カレンダーを開く）" }));
      expect(scrollSpy).toHaveBeenCalled();
      expect(h.push).not.toHaveBeenCalled();
    } finally {
      window.HTMLElement.prototype.scrollIntoView = orig;
      anchor.remove();
    }
  });
});
