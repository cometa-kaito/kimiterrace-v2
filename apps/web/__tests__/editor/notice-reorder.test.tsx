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

describe("NoticeEditor 並べ替え（ドラッグ / ↑↓キー・上下ボタンは廃止）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.setNoticesAction.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("グリップに ↑ キーで 2 件目が 1 件目になり、その順序で自動保存される", async () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);

    // 2 件目（連絡B）のグリップで ↑。ポインタ D&D は jsdom 非対応なので同じ並べ替え経路をキーボードで叩く。
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: "2 件目を並べ替え" }), {
        key: "ArrowUp",
      });
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

  it("先頭で ↑ / 末尾で ↓ は順序を変えない（端の行は動かせない）", () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={items()} />);
    const textAt = (row: number) =>
      (screen.getByLabelText(`${row} 件目の連絡事項`) as HTMLInputElement).value;
    fireEvent.keyDown(screen.getByRole("button", { name: "1 件目を並べ替え" }), { key: "ArrowUp" });
    expect(textAt(1)).toBe("連絡A");
    fireEvent.keyDown(screen.getByRole("button", { name: "3 件目を並べ替え" }), {
      key: "ArrowDown",
    });
    expect(textAt(3)).toBe("連絡C");
  });

  it("連絡が 1 件だけのときはドラッグハンドルを出さない", () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={[{ text: "唯一" }]} />);
    expect(screen.queryByRole("button", { name: /件目を並べ替え/ })).toBeNull();
  });

  // #1166 で導入した事前生成の空行（prefillRows）はハンドルのゲートを `rows.length` でなく `filledRows.length`
  // で見る（来校者/呼び出しエディタと同じ）。空行は掴ませない・本文 1 件では並べ替え不要。
  it("事前生成の空行には並べ替えハンドルを出さない（1 件入力 + 空行 4 行 → ハンドル 0）", () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ text: "連絡A" }]}
        prefillRows={5}
      />,
    );
    // 空行を含め 5 行ぶん描画される（事前生成）が、本文の入った行は 1 件だけ。
    expect(screen.getByLabelText("5 件目の連絡事項")).toBeTruthy();
    expect(screen.queryByLabelText("6 件目の連絡事項")).toBeNull();
    // 本文が 1 件 → 並べ替え不要なのでハンドルは 1 つも出ない（空の事前生成行も掴ませない）。
    expect(screen.queryAllByRole("button", { name: /件目を並べ替え/ })).toHaveLength(0);
  });

  it("本文の入った行にだけハンドルを出す（2 件入力 + 空行 3 行 → ハンドル 2・空行には出さない）", () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ text: "連絡A" }, { text: "連絡B" }]}
        prefillRows={5}
      />,
    );
    // 5 行ぶん描画されるが、ハンドルは本文の入った先頭 2 行だけ（空行 3 行には出ない）。
    expect(screen.getByLabelText("5 件目の連絡事項")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /件目を並べ替え/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "1 件目を並べ替え" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2 件目を並べ替え" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "3 件目を並べ替え" })).toBeNull();
  });

  // #1175 と同型のバグ: 事前生成（盤面の規定枠ぶん）の空行があると、最後の実入力行で ↓ を押したとき
  // useRowReorder.move が `to < count`(=空行込み rows.length) しか境界チェックしないため、行き先が末尾の
  // 空行スロットでも moveItem が実入力行をそこへ swap し、実入力行どうしの間に空行が挟まって「行間が空いて
  // 盤面が崩れて見える」見た目バグになっていた。moveRow の空行ドロップ先ガードで no-op になることを固定する。
  it("末尾の実入力行で ↓ を押しても空行へ移らず順序不変（事前生成の空行へ落とさない）", () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ text: "連絡A" }, { text: "連絡B" }]}
        prefillRows={5}
      />,
    );
    const textAt = (row: number) =>
      (screen.getByLabelText(`${row} 件目の連絡事項`) as HTMLInputElement).value;
    // 2 件入力 + 空行 3 行（事前生成 5 枠）。最後の実入力行（2 件目 = 連絡B）のグリップで ↓。
    // ポインタ D&D は jsdom 非対応なので同じ並べ替え経路をキーボードで叩く（↓ は move(1, 2) を呼ぶ）。
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: "2 件目を並べ替え" }), {
        key: "ArrowDown",
      });
    });
    // 行き先（3 行目）は空行 → no-op。実入力行は [連絡A, 連絡B] のまま（間に空行が挟まらない）。
    expect(textAt(1)).toBe("連絡A");
    expect(textAt(2)).toBe("連絡B");
    expect(textAt(3)).toBe("");
  });
});
