import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 「別の日も準備する」カレンダー（{@link EditorDateCalendar}）と、内容ドット用の期間窓 `monthWindow`
 * （純関数）の固定テスト。
 *
 * - 月表示・選択した日（aria-current=date）・内容のある日の点（aria-label の「内容あり」）・日付クリックでの
 *   `?plan=` 遷移・月送り・未選択時の挙動を確認する。
 * - **add-on 改善（2026-06-23）**: クイックチップ（明日/あさって）の遷移・過去日の無効化・今日クリックの空振り
 *   解消（?plan を出さない）・選択後の自動スクロールも固定する。
 * - 「今日」はサーバ props（`today`）で渡るので、月送り系テストでは 6 月以外（2 月）に固定し、表示中の 6 月セルに
 *   「・今日」が付かないようにしてラベル一致を安定させる。過去日/今日クリックのテストは 6 月に今日を置いて確認する。
 */

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
}));

import {
  EditorDateCalendar,
  SELECTED_DAY_ANCHOR_ID,
} from "../../app/app/editor/[classId]/_components/EditorDateCalendar";
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
  it("選択した日の月を表示し、内容のある日に点（内容あり）を出す", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-06-23"
        contentDates={["2026-06-25"]}
      />,
    );
    expect(screen.getByText("2026年6月")).toBeTruthy();
    // 25 日は内容あり（aria-label に反映）。
    expect(screen.getByLabelText("2026年6月25日・内容ありを編集")).toBeTruthy();
    // 10 日は内容なし。
    expect(screen.getByLabelText("2026年6月10日を編集")).toBeTruthy();
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

  it("日付クリックで ?plan= へ遷移する（下の「選択した日の編集」に入る）", () => {
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
    expect(h.push).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}?plan=2026-06-25`, {
      scroll: false,
    });
  });

  it("未選択（selectedDate なし）は畳まれていて、開くと今日の月が出る（選択 aria-current は無し）", () => {
    render(<EditorDateCalendar classId={CLASS_ID} today={TODAY} contentDates={[]} />);
    const toggle = screen.getByRole("button", { name: /別の日も準備する/ });
    // 既定は畳む（aria-expanded=false・月グリッドは出ない）。
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("2026年2月")).toBeNull();
    // 開くと今日の月（2月）が出る。選択中の日は無いので aria-current=date も無い。
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("2026年2月")).toBeTruthy();
    expect(screen.queryByRole("button", { current: "date" })).toBeNull();
  });

  it("選択中（selectedDate あり）は最初から開いて出す（使用中は開けておく）", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today={TODAY}
        selectedDate="2026-06-23"
        contentDates={[]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /別の日も準備する/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("2026年6月")).toBeTruthy();
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

  it("クイックチップ「明日 / あさって」は畳んでいても押せ、その日へ ?plan= 遷移する", () => {
    // 畳んだ状態（selectedDate なし）でもチップはヘッダーに常設される（月グリッドを開かず 1 タップ）。
    render(<EditorDateCalendar classId={CLASS_ID} today={TODAY} contentDates={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /明日/ }));
    expect(h.push).toHaveBeenLastCalledWith(`/app/editor/${CLASS_ID}?plan=2026-02-16`, {
      scroll: false,
    });
    fireEvent.click(screen.getByRole("button", { name: /あさって/ }));
    expect(h.push).toHaveBeenLastCalledWith(`/app/editor/${CLASS_ID}?plan=2026-02-17`, {
      scroll: false,
    });
  });

  it("過去日（昨日以前）は無効化され、クリックしても遷移しない", () => {
    // 今日を 6 月に置く（6/20）。19 日は過去 → disabled。20 日（今日）は押せる。
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

  it("カレンダーで「今日」を押しても ?plan= は出さない（空振り解消・上の今日へ戻す）", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
        today="2026-06-20"
        selectedDate="2026-06-23"
        contentDates={[]}
      />,
    );
    // 今日（6/20）セルをクリック → ?plan は今日と同じで下に何も出ないので push しない（スクロールで戻すだけ）。
    fireEvent.click(screen.getByLabelText("2026年6月20日・今日を編集"));
    expect(h.push).not.toHaveBeenCalled();
  });

  it("先の日を選ぶと下の「選択した日の編集」へ自動スクロールする", () => {
    const scrollSpy = vi.fn();
    // jsdom は scrollIntoView 未実装。プロトタイプに差して呼び出しを検出する（テスト後に復元）。
    const orig = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;
    const anchor = document.createElement("div");
    anchor.id = SELECTED_DAY_ANCHOR_ID;
    document.body.appendChild(anchor);
    try {
      const { rerender } = render(
        <EditorDateCalendar classId={CLASS_ID} today={TODAY} contentDates={[]} />,
      );
      // 畳んでいてもチップは押せる。明日（2026-02-16）を選ぶ。
      fireEvent.click(screen.getByRole("button", { name: /明日/ }));
      // サーバ反映を模して selectedDate を反映 → useEffect が下のアンカーへスクロールする。
      rerender(
        <EditorDateCalendar
          classId={CLASS_ID}
          today={TODAY}
          selectedDate="2026-02-16"
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
