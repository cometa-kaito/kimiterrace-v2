import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * クラスエディタ最下部の「日付を選んで編集」カレンダー（{@link EditorDateCalendar}）と、内容ドット用の
 * 期間窓 `monthWindow`（純関数）の固定テスト。
 *
 * - 月表示・編集中の日（aria-current=date）・内容のある日の点（aria-label の「内容あり」）・日付クリックでの
 *   `?date=` 遷移・月送りを確認する。
 * - 「今日」の強調はマウント後に実時刻で決まるため、テスト中は 6 月以外（2 月）に固定し、表示中（6 月）の
 *   セルに「・今日」が付かないようにしてラベル一致を安定させる。
 */

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
}));

import { EditorDateCalendar } from "../../app/app/editor/[classId]/_components/EditorDateCalendar";
import { monthWindow } from "../../lib/editor/content-dates";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";

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
  beforeEach(() => {
    // 「今日」を 6 月以外（2 月）に固定し、表示中の 6 月セルに「・今日」が付かないようにする。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("選択月を表示し、内容のある日に点（内容あり）を出す", () => {
    render(
      <EditorDateCalendar
        classId={CLASS_ID}
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

  it("編集中の日（selectedDate）に aria-current=date を付ける", () => {
    render(<EditorDateCalendar classId={CLASS_ID} selectedDate="2026-06-23" contentDates={[]} />);
    const sel = screen.getByLabelText("2026年6月23日を編集");
    expect(sel.getAttribute("aria-current")).toBe("date");
  });

  it("日付をクリックするとその日の編集へ遷移する（?date=）", () => {
    render(<EditorDateCalendar classId={CLASS_ID} selectedDate="2026-06-23" contentDates={[]} />);
    fireEvent.click(screen.getByLabelText("2026年6月25日を編集"));
    expect(h.push).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}?date=2026-06-25`);
  });

  it("前の月 / 次の月で表示月が変わる", () => {
    render(<EditorDateCalendar classId={CLASS_ID} selectedDate="2026-06-23" contentDates={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "次の月" }));
    expect(screen.getByText("2026年7月")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "前の月" }));
    fireEvent.click(screen.getByRole("button", { name: "前の月" }));
    expect(screen.getByText("2026年5月")).toBeTruthy();
  });
});
