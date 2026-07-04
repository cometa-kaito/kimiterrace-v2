import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 計画ゾーンの月カレンダー（{@link EditorDateCalendar}）と、内容ドット用の期間窓 `monthWindow`
 * （純関数）の固定テスト。
 *
 * 単一スタック化（editor-restructure-bulletin-2026-07.md §3）後の仕様を固定する:
 * - 日付クリックは `?date=`（旧 `?plan=` は廃止・redirect 互換は page 側）で、対象日そのものを切り替える。
 * - 折りたたみトグル・クイックチップ（明日/あさって）・説明 hint は廃止＝**常設で開く**。
 * - 選択中の日（aria-current=date）・内容ドット・過去日の無効化・月送りは温存。
 * - 選択反映後は上の編集スタック（{@link EDITOR_STACK_ANCHOR_ID}）へ自動スクロールして戻す。
 * - 「今日」はサーバ props（`today`）で渡るので、月送り系テストでは 6 月以外（2 月）に固定し、表示中の
 *   6 月セルに「・今日」が付かないようにしてラベル一致を安定させる。
 */

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
}));

import { EditorDateCalendar } from "../../app/app/editor/[classId]/_components/EditorDateCalendar";
import {
  EDITOR_CALENDAR_ANCHOR_ID,
  EDITOR_STACK_ANCHOR_ID,
} from "../../app/app/editor/[classId]/_components/editor-anchors";
import { monthWindow } from "../../lib/editor/content-dates";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
// 今日は 6 月以外（2 月）に固定し、表示中の 6 月セルに「・今日」が付かないようにする（ラベル一致の安定化）。
const TODAY = "2026-02-15";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("monthWindow（内容ドットの取得窓・純関数）", () => {
  it("選択月の前月 1 日〜翌月末日を返す", () => {
    expect(monthWindow("2026-06-23")).toEqual({ start: "2026-05-01", end: "2026-07-31" });
  });
  it("年をまたぐ（1 月→前年 12 月 / 12 月→翌年 1 月）", () => {
    expect(monthWindow("2026-01-10")).toEqual({ start: "2025-12-01", end: "2026-02-28" });
    expect(monthWindow("2026-12-10")).toEqual({ start: "2026-11-01", end: "2027-01-31" });
  });
});

describe("EditorDateCalendar", () => {
  it("常設で開き（トグル無し）、選択した日の月を表示し、内容のある日に点（内容あり）を出す", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-06-23"
        contentDates={["2026-06-25"]}
      />,
    );
    // 旧「別の日も準備する」折りたたみトグルは廃止＝月グリッドが最初から出る。
    expect(screen.queryByRole("button", { name: /別の日も準備する/ })).toBeNull();
    expect(screen.getByText("2026年6月")).toBeTruthy();
    // 25 日は内容あり（aria-label に反映）。
    expect(screen.getByLabelText("2026年6月25日・内容ありを編集")).toBeTruthy();
    // 10 日は内容なし。
    expect(screen.getByLabelText("2026年6月10日を編集")).toBeTruthy();
  });

  it("セグメント「📅 ほかの日」のスクロール先アンカー id を持つ", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-06-23"
        contentDates={[]}
      />,
    );
    expect(document.getElementById(EDITOR_CALENDAR_ANCHOR_ID)).toBeTruthy();
  });

  it("選択した日（selectedDate）に aria-current=date を付ける", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-06-23"
        contentDates={[]}
      />,
    );
    expect(screen.getByLabelText("2026年6月23日を編集").getAttribute("aria-current")).toBe("date");
  });

  it("日付クリックで ?date= へ遷移する（対象日そのものが切り替わる・旧 ?plan は発行しない）", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-06-23"
        contentDates={[]}
      />,
    );
    fireEvent.click(screen.getByLabelText("2026年6月25日を編集"));
    // scroll:false 付きで遷移する（ページ先頭へ飛ばさない・カレンダー位置を保つ）。
    expect(h.push).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}?date=2026-06-25`, {
      scroll: false,
    });
  });

  it("前の月 / 次の月で表示月が変わる", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-06-23"
        contentDates={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "次の月" }));
    expect(screen.getByText("2026年7月")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "前の月" }));
    fireEvent.click(screen.getByRole("button", { name: "前の月" }));
    expect(screen.getByText("2026年5月")).toBeTruthy();
  });

  it("過去日（昨日以前）は無効化され、クリックしても遷移しない", () => {
    // 今日を 6 月に置く（6/20）。19 日は過去 → disabled。
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today="2026-06-20"
        selectedDate="2026-06-23"
        contentDates={[]}
      />,
    );
    const past = screen.getByLabelText("2026年6月19日を編集") as HTMLButtonElement;
    expect(past.disabled).toBe(true);
    fireEvent.click(past);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("「今日」をクリックすると ?date=今日 へ遷移する（今日も単一スタックの対象日として選べる）", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today="2026-06-20"
        selectedDate="2026-06-23"
        contentDates={[]}
      />,
    );
    fireEvent.click(screen.getByLabelText("2026年6月20日・今日を編集"));
    expect(h.push).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}?date=2026-06-20`, {
      scroll: false,
    });
  });

  it("選択中の日をクリックしても再ナビせず、上の編集スタックへスクロールで戻す（空振り防止）", () => {
    const scrollSpy = vi.fn();
    const orig = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;
    const anchor = document.createElement("div");
    anchor.id = EDITOR_STACK_ANCHOR_ID;
    document.body.appendChild(anchor);
    try {
      render(
        <EditorDateCalendar
          classId={CLASS_ID}
          today="2026-06-20"
          selectedDate="2026-06-23"
          contentDates={[]}
        />,
      );
      fireEvent.click(screen.getByLabelText("2026年6月23日を編集"));
      expect(h.push).not.toHaveBeenCalled();
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      window.HTMLElement.prototype.scrollIntoView = orig;
      anchor.remove();
    }
  });

  it("日付を選んでサーバ反映されると上の編集スタックへ自動スクロールする", () => {
    const scrollSpy = vi.fn();
    // jsdom は scrollIntoView 未実装。プロトタイプに差して呼び出しを検出する（テスト後に復元）。
    const orig = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;
    const anchor = document.createElement("div");
    anchor.id = EDITOR_STACK_ANCHOR_ID;
    document.body.appendChild(anchor);
    try {
      const { rerender } = render(
        <EditorDateCalendar
          classId={CLASS_ID}
          today={TODAY}
          selectedDate="2026-02-16"
          contentDates={[]}
        />,
      );
      // 2/20 を選ぶ → ?date= ソフトナビ（この時点ではまだスクロールしない）。
      fireEvent.click(screen.getByLabelText("2026年2月20日を編集"));
      expect(scrollSpy).not.toHaveBeenCalled();
      // サーバ反映を模して selectedDate を更新 → useEffect が上の編集スタックへスクロールする。
      rerender(
        <EditorDateCalendar
          classId={CLASS_ID}
          today={TODAY}
          selectedDate="2026-02-20"
          contentDates={[]}
        />,
      );
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      window.HTMLElement.prototype.scrollIntoView = orig;
      anchor.remove();
    }
  });
});
