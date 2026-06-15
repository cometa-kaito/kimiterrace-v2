import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoSaveSection } from "@/lib/editor/editor-save-state";

/**
 * 自動保存フック（{@link useAutoSaveSection}）の検証。明示的な「保存」操作を廃した UIUX の核なので、
 * 「dirty かつ complete で debounce 後に保存 / 未完成では保存しない / flush は即時 / 未変更では保存しない」
 * を固定する。save 失敗時のエラー保持も確認する。
 */

type Props = {
  serialized: string;
  items: unknown[];
  complete: boolean;
};

type SaveResult = { ok: true } | { ok: false; error: { message: string } };

function setup(
  initial: Props,
  save: (items: unknown[]) => Promise<SaveResult> = vi.fn(async () => ({ ok: true as const })),
) {
  const { result, rerender } = renderHook(
    (props: Props) => useAutoSaveSection({ ...props, save, debounceMs: 800 }),
    { initialProps: initial },
  );
  return { save, result, rerender };
}

describe("useAutoSaveSection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("初期表示（未変更）では保存しない", async () => {
    const { save } = setup({ serialized: "[]", items: [], complete: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("dirty かつ complete なら debounce 後に最新ペイロードで自動保存する", async () => {
    const { save, rerender, result } = setup({
      serialized: "A",
      items: [{ a: 1 }],
      complete: true,
    });
    rerender({ serialized: "B", items: [{ a: 2 }], complete: true });
    expect(save).not.toHaveBeenCalled(); // debounce 満了前は保存しない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith([{ a: 2 }]);
    expect(result.current.status).toBe("saved");
  });

  it("未完成（complete=false）の間は保存せず incomplete を示す", async () => {
    const { save, rerender, result } = setup({
      serialized: "A",
      items: [{ a: 1 }],
      complete: true,
    });
    rerender({ serialized: "B", items: [{ a: 2 }], complete: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.status).toBe("incomplete");
  });

  it("flush() は debounce を待たず即時保存する", async () => {
    const { save, rerender, result } = setup({
      serialized: "A",
      items: [{ a: 1 }],
      complete: true,
    });
    rerender({ serialized: "B", items: [{ a: 2 }], complete: true });
    await act(async () => {
      await result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("保存失敗時は error 状態とメッセージを保持する", async () => {
    const failing = vi.fn(async () => ({ ok: false as const, error: { message: "失敗理由" } }));
    const { result, rerender } = setup(
      { serialized: "A", items: [{ a: 1 }], complete: true },
      failing,
    );
    rerender({ serialized: "B", items: [{ a: 2 }], complete: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("失敗理由");
  });
});
