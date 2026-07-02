import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import { blockRowCapacity, type SignageBlockKind } from "@/lib/signage/pattern-blocks";

/**
 * **盤面ページング（F1・editor-input-tiers-and-signage-paging.md）の純関数レイヤ**。
 *
 * 規定行数（`blockRowCapacity` = 盤面/エディタ共通の単一ソース）を超えた編集ブロックを、連続スクロールの
 * 代わりに**複数ページへ分割し、一定滞留ごとに切り替えて全件見せる**（オーナー確定 2026-07-02＝連続マーキー
 * ではなくページング。根拠は盤面設計指針の滞留 5–10 秒・廊下距離の可読性）。本モジュールは client-safe な
 * 純関数と定数のみ（postgres / hooks を持たない）。表示側は `BoardPager`（client island）が担う。
 *
 * 容量値をここに**再定義しない**: 規定行数は `pattern-blocks.ts` の `blockRowCapacity` が唯一の権威
 * （2026-06-23 ユーザー確定・全編集ブロック 5）。本モジュールが持つのは「1 ページに載せる件数」への**例外
 * 上書きだけ**（自然高さで 1 件 2 行になりうるブロックは低めに載せる等）。
 */

/**
 * 1 ページの滞留時間（ms）。盤面設計指針（滞留 5–10 秒）に合わせ**初期値 8 秒**（設計書 §3 F1・§6-2）。
 * 実機（岐南の Google TV）で調整する余地を残すため定数化。ニュースの `NEWS_DWELL_MS`（15 秒・文章量が多い）や
 * 広告の滞留（MIN_AD_MS 系）とは**独立タイマー**＝同期しない（設計書 §3 F1「広告との非干渉」）。
 */
export const SIGNAGE_PAGE_DWELL_MS = 8_000;

/**
 * パターン × ブロックの「1 ページに載せる件数」への例外上書き。**既定は `blockRowCapacity`**（規定行数 =
 * 1 ページ）で、ここに書くのは自然高さアイテム（氏名 + 用件メタで 1 件 2 行になりうる呼び出し / 来校者等）を
 * 保守的（低め）に載せる場合だけ。低すぎはページが増えるだけで安全、高すぎはページ内で再クリップ＝切り捨てが
 * 復活するため、迷ったら低めに倒す（実機で調整・設計書 §6）。
 */
const PAGE_SIZE_OVERRIDES: Partial<
  Record<SignageDesignPattern, Partial<Record<SignageBlockKind, number>>>
> = {
  // pattern2 の呼び出し / 来校者は自然高さ（氏名 + 用件メタの 2 行アイテム）を切らないため 1 ページ 3 件に抑える
  // （PR-1b の実測見積り）。予定は 1 行/コマなので既定（規定行数 5）のまま。
  pattern2: { callout: 3, visitor: 3 },
};

/**
 * パターン × ブロックの 1 ページ件数を返す。既定は規定行数 `blockRowCapacity`（そのパターンがブロックを
 * 出さない組み合わせは 0 → `null`）。0 以下の不正値も `null` に倒す（ページ分割で 0 除算・無限ページを
 * 作らない安全側・fail-soft）。
 */
export function boardPageSize(
  pattern: SignageDesignPattern,
  kind: SignageBlockKind,
): number | null {
  // 未知パターンの fail-soft（pattern1 相当へ）は blockRowCapacity 側が既に担う。上書き表は既知パターンのみ引く。
  const override = PAGE_SIZE_OVERRIDES[pattern]?.[kind];
  const rows = override ?? blockRowCapacity(pattern, kind);
  return typeof rows === "number" && rows > 0 ? rows : null;
}

/**
 * 配列を先頭から `size` 件ずつのページに分割する（純関数・元配列は破壊しない）。`size<=0` や空配列は
 * 「1 ページ（元配列のコピーそのまま）」に倒す（ページャの発動条件は `pages.length > 1`＝ここで 0 除算・
 * 無限ループを作らない）。
 */
export function chunkIntoPages<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0 || items.length === 0) {
    return [items.slice()];
  }
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}
