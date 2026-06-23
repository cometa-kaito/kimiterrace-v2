import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 「先の日を選んで編集」カレンダー（{@link EditorDateCalendar}）と、内容ドット用の期間窓 `monthWindow`
 * （純関数）の固定テスト。
 *
 * - 月表示・選択した日（aria-current=date）・内容のある日の点（aria-label の「内容あり」）・日付クリックでの
 *   `?plan=` 遷移・月送り・未選択時の挙動を確認する。
 * - 「今日」はサーバ props（`today`）で渡るので、テストでは 6 月以外（2 月）に固定し、表示中の 6 月セルに
 *   「・今日」が付かないようにしてラベル一致を安定させる。
 */

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
}));

import { EditorDateCalendar } from "../../app/app/editor/[classId]/_components/EditorDateCalendar";
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
    expect(h.push).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}?plan=2026-06-25`);
  });

  it("未選択（selectedDate なし）なら今日の月を表示し、選択（aria-current=date）は出さない", () => {
    render(<EditorDateCalendar classId={CLASS_ID} today={TODAY} contentDates={[]} />);
    expect(screen.getByText("2026年2月")).toBeTruthy();
    expect(screen.queryByRole("button", { current: "date" })).toBeNull();
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
});
