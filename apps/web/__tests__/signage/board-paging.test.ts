import { describe, expect, it } from "vitest";

import {
  SIGNAGE_PAGE_DWELL_MS,
  boardPageSize,
  chunkIntoPages,
} from "../../lib/signage/board-paging";
import type { SignageDesignPattern } from "../../lib/signage/design-pattern";
import { blockRowCapacity } from "../../lib/signage/pattern-blocks";

/**
 * F1 盤面ページングの純関数レイヤ（board-paging.ts）。ページ分割と 1 ページ件数の解決を pin する。
 * 容量の権威は `blockRowCapacity`（pattern-blocks.ts）のまま＝本モジュールが値を再定義していないことも守る。
 */
describe("chunkIntoPages", () => {
  it("規定件数ごとに先頭から分割する（7 件 / 5 件页 → 5 + 2）", () => {
    const pages = chunkIntoPages([1, 2, 3, 4, 5, 6, 7], 5);
    expect(pages).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7],
    ]);
  });

  it("ちょうど割り切れる件数は余分な空ページを作らない（10 件 / 5 → 2 ページ）", () => {
    expect(chunkIntoPages([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toHaveLength(2);
  });

  it("空配列は 1 ページ（空ページ）に倒す（ページャ発動条件 pages.length>1 を満たさない）", () => {
    expect(chunkIntoPages([], 5)).toEqual([[]]);
  });

  it("size<=0 の不正値は分割せず 1 ページに倒す（0 除算・無限ページを作らない）", () => {
    expect(chunkIntoPages([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(chunkIntoPages([1, 2, 3], -1)).toEqual([[1, 2, 3]]);
  });

  it("元配列を破壊しない", () => {
    const src = [1, 2, 3, 4, 5, 6];
    chunkIntoPages(src, 5);
    expect(src).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("boardPageSize", () => {
  it("既定は規定行数の単一ソース blockRowCapacity と一致する（pattern1 の予定/連絡/提出物 = 5）", () => {
    for (const kind of ["schedule", "notice", "assignment"] as const) {
      expect(boardPageSize("pattern1", kind)).toBe(blockRowCapacity("pattern1", kind));
      expect(boardPageSize("pattern1", kind)).toBe(5);
    }
  });

  it("そのパターンが出さないブロックは null（ページング対象外・fail-soft）", () => {
    expect(boardPageSize("pattern1", "callout")).toBeNull();
    expect(boardPageSize("pattern4", "schedule")).toBeNull();
  });

  it("pattern2 の呼び出し/来校者は自然高さ（2 行アイテム）対策の保守的上書き = 3", () => {
    expect(boardPageSize("pattern2", "callout")).toBe(3);
    expect(boardPageSize("pattern2", "visitor")).toBe(3);
    // 上書きの無いブロックは既定（規定行数）のまま。
    expect(boardPageSize("pattern2", "schedule")).toBe(blockRowCapacity("pattern2", "schedule"));
  });

  it("未知パターンは blockRowCapacity の fail-soft（pattern1 相当）に倒れる", () => {
    expect(boardPageSize("patternX" as SignageDesignPattern, "schedule")).toBe(5);
  });
});

describe("SIGNAGE_PAGE_DWELL_MS", () => {
  it("盤面設計指針の滞留 5–10 秒の範囲（初期値 8 秒）", () => {
    expect(SIGNAGE_PAGE_DWELL_MS).toBeGreaterThanOrEqual(5_000);
    expect(SIGNAGE_PAGE_DWELL_MS).toBeLessThanOrEqual(10_000);
  });
});
