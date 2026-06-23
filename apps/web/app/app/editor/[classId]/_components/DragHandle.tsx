"use client";

import { gripStyle } from "./editor-styles";
import type { RowReorder } from "./useRowReorder";

/**
 * 並べ替え用ドラッグハンドル（グリップ ⠿）。連絡 / 来校者 / 生徒呼び出しの各エディタで共有する。
 *
 * 操作（要望 2026-06-23: 上下ボタンは廃止しドラッグ主体・ただしタッチでも動く・キーボードも残す）:
 * - マウス / **タッチ** / ペンで掴んでドラッグ&ドロップ（{@link useRowReorder} の Pointer Events）。
 * - フォーカスして `↑`/`↓` キーでも 1 つ移動（可視ボタンを置かずにキーボード経路を残す＝a11y）。
 *
 * グリップは操作要素なので `role="button"` + `tabIndex=0` + `aria-label`（位置入り）にする。`aria-label` は
 * 呼び出し側が「N 行目を並べ替え」等の文言を渡す（来校者/呼び出しは「行目」、連絡は「件目」で表現を合わせる）。
 */
export function DragHandle({ reorder, label }: { reorder: RowReorder; label: string }) {
  return (
    <button
      type="button"
      {...reorder.handleProps}
      aria-label={label}
      title="ドラッグ、または ↑↓ キーで並べ替え"
      style={gripStyle}
    >
      ⠿
    </button>
  );
}
