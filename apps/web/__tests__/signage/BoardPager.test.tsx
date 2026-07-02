import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardPager } from "../../app/(signage)/signage/[classToken]/_components/BoardPager";

/**
 * F1 盤面ページング（`BoardPager` client island）の挙動テスト。オーナー確定（editor-input-tiers-and-signage-
 * paging.md）＝溢れを黙って切り捨てず**全ページを DOM に積み、どのページの行も必ず読める**（切り捨てゼロ）。
 * 視覚（フェード・opacity）は jsdom で検証できないため、ここで pin するのは構造（DOM 保持 / aria-hidden /
 * タイマー切替 / play 停止）のみ。
 */
afterEach(() => {
  vi.useRealTimers();
});

function pagesOf(n: number): React.ReactNode[] {
  return Array.from({ length: n }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 固定長のテスト用ページ列（並び替えない）
    <div key={i} data-testid={`p-${i}`}>{`ページ${i}`}</div>
  ));
}

describe("BoardPager（自動ページ切替 client island）", () => {
  it("全ページを DOM に積み（切り捨てゼロ）、初期は先頭ページのみ active・他は aria-hidden", () => {
    render(<BoardPager pages={pagesOf(3)} dwellMs={8000} />);
    for (const i of [0, 1, 2]) {
      expect(screen.getByTestId(`p-${i}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("p-0").parentElement).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("p-1").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("p-2").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("dwellMs 経過で次ページが active になり、末尾から先頭へ循環する", () => {
    vi.useFakeTimers();
    render(<BoardPager pages={pagesOf(3)} dwellMs={8000} />);
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByTestId("p-1").parentElement).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("p-0").parentElement).toHaveAttribute("aria-hidden", "true");
    // さらに 2 回（2 → 0）で先頭へ循環。
    act(() => {
      vi.advanceTimersByTime(16000);
    });
    expect(screen.getByTestId("p-0").parentElement).not.toHaveAttribute("aria-hidden");
  });

  it("1 ページのみのときはタイマーを張らず、切替もインジケータも起きない（静的）", () => {
    vi.useFakeTimers();
    render(<BoardPager pages={pagesOf(1)} dwellMs={8000} />);
    act(() => {
      vi.advanceTimersByTime(80000);
    });
    expect(screen.getByTestId("p-0").parentElement).not.toHaveAttribute("aria-hidden");
  });

  it("play=false では切替を止め、先頭ページを静的表示する（AutoScroll の play と同作法）", () => {
    vi.useFakeTimers();
    render(<BoardPager pages={pagesOf(3)} dwellMs={8000} play={false} />);
    act(() => {
      vi.advanceTimersByTime(80000);
    });
    expect(screen.getByTestId("p-0").parentElement).not.toHaveAttribute("aria-hidden");
    expect(screen.getByTestId("p-1").parentElement).toHaveAttribute("aria-hidden", "true");
  });
});
