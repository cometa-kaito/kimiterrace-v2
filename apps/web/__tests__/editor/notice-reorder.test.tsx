import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveItem } from "../../app/app/editor/[classId]/_components/useRowReorder";

/**
 * D 群（並べ替え）: 連絡（NoticeEditor）の行を D&D / 「上へ・下へ」で並べ替えると、**配列順がそのまま保存
 * ペイロード順になる**ことを固定する。連絡は `validateNoticeItems` が入力順を保持し盤面も同じ配列順で描画する
 * ため、並べ替え順 = 表示順となる（migration 不要・盤面の表示物は増減しない＝順序だけ変わる）。
 *
 * 保存は既存の自動保存（dirty = serialized 変化）に乗る。server action をモックし、並べ替え後に最新の順序で
 * setNoticesAction が呼ばれることを確認する（保存・検証・RLS/監査はサーバ側が担い、ここは UI 連動のみ）。
 */

const h = vi.hoisted(() => ({
  setNoticesAction: vi.fn(async (..._args: unknown[]) => ({
    ok: true as const,
    data: { count: 0 },
  })),
}));

vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.setNoticesAction(...a),
  setAssignmentsAction: vi.fn(),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({ setScheduleAction: vi.fn() }));

import { NoticeEditor } from "../../app/app/editor/[classId]/_components/NoticeEditor";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-22";

function items() {
  return [{ text: "連絡A" }, { text: "連絡B" }, { text: "連絡C" }];
}

describe("moveItem", () => {
  it("from を to へ移す（順序のみ変更）", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 1, 0)).toEqual(["b", "a", "c"]);
  });
  it("範囲外 / 同一は元配列をそのまま返す（参照同一）", () => {
    const arr = ["a", "b"];
    expect(moveItem(arr, 0, 0)).toBe(arr);
    expect(moveItem(arr, 0, 5)).toBe(arr);
    expect(moveItem(arr, -1, 1)).toBe(arr);
  });
});

describe("NoticeEditor 並べ替え", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.setNoticesAction.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("「上へ」ボタンで 2 件目が 1 件目になり、その順序で自動保存される", async () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);

    // 2 件目（連絡B）を上へ。aria-label で位置を特定（色だけに依存しない操作経路）。
    const upB = screen.getByLabelText("2 件目を上へ移動（全 3 件中）");
    act(() => {
      fireEvent.click(upB);
    });

    // 並べ替えで serialized が変化 → debounce 後に自動保存。最新順序 [B, A, C] で呼ばれる。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(h.setNoticesAction).toHaveBeenCalled();
    const lastCall = h.setNoticesAction.mock.calls.at(-1) as unknown[];
    const savedItems = lastCall[3] as { text: string }[];
    expect(savedItems.map((n) => n.text)).toEqual(["連絡B", "連絡A", "連絡C"]);
  });

  it("先頭の「上へ」と末尾の「下へ」は無効（端の行は動かせない）", () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    expect(screen.getByLabelText("1 件目を上へ移動（全 3 件中）")).toBeDisabled();
    expect(screen.getByLabelText("3 件目を下へ移動（全 3 件中）")).toBeDisabled();
  });

  it("行が 1 件だけのときは並べ替えコントロールを出さない", () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={[{ text: "唯一" }]} />);
    expect(screen.queryByLabelText(/上へ移動/)).toBeNull();
  });
});
