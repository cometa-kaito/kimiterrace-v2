"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";

/**
 * エディタの可変フォーム行（**並べ替えた順がそのまま盤面の表示順になる**セクション）を並べ替える純フック
 * （連絡・来校者・生徒呼び出しで使用）。`reorder(from, to)` を呼ぶと配列を組み替える。
 *
 * ## 入力方式（要望 2026-06-23: 上へ/下へボタンは廃止し「ドラッグのみ」に。ただしタッチでも動くこと）
 * - **ポインタ D&D**: Pointer Events（マウス / **タッチ** / ペンを 1 経路で扱う）。グリップを `onPointerDown` で
 *   掴み、`setPointerCapture` で以降の `pointermove`/`pointerup` をグリップに集める。移動中は
 *   `document.elementFromPoint` で指/カーソル直下の行（`data-reorder-index`）を判定してドロップ先にする。
 *   旧 HTML5 D&D（`draggable`）は**タッチ端末で発火しない**ため不採用（タブレット対応の主目的）。
 * - **キーボード**: グリップを `tabIndex=0` でフォーカスし `↑`/`↓` で 1 つ移動（D&D の代替・色や視覚に依存しない）。
 *   これにより、可視の上下ボタンを置かずにキーボード/支援技術での並べ替えを残す（a11y）。
 *
 * 永続化はこのフックでは行わない。呼び出し側が並べ替え後の state を**既存の保存経路**（自動保存）へ流す。
 * State はインデックス基準（行の安定キーは描画側が持つ）。並べ替え対象は同一リスト内に限る。
 */

/** 1 行ぶんの並べ替えハンドル。グリップに撒く `handleProps`、行（ドロップ先）に撒く `rowProps`、表示用フラグ。 */
export type RowReorder = {
  /** この行を今ドラッグ中か（半透明表示などに使う）。 */
  isDragging: boolean;
  /** ドロップ先候補としてホバー中か（差し込み線ヒントに使う）。 */
  isOver: boolean;
  /** グリップ（ドラッグハンドル）に撒く props（ポインタ D&D ＋ ↑↓ キー）。 */
  handleProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  };
  /** 行（ドロップ先）に撒く props。ヒットテスト（elementFromPoint）の目印になる data 属性。 */
  rowProps: { "data-reorder-index": number };
};

/**
 * 並べ替えフック。`count` は現在の行数、`reorder(from, to)` は「from の行を to の位置へ移す」コールバック
 * （呼び出し側が自分の state を組み替える）。`disabled` 時はドラッグ/移動を無効化する（保存中など）。
 * `rowReorder(index)` を各行へ渡す。
 */
export function useRowReorder(
  count: number,
  reorder: (from: number, to: number) => void,
  disabled = false,
): (index: number) => RowReorder {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  // ポインタ移動中はクロージャの再生成に依らず最新値を読みたいので ref も併用する。
  const dragRef = useRef<number | null>(null);
  const overRef = useRef<number | null>(null);

  const move = (from: number, to: number) => {
    if (disabled || from === to || to < 0 || to >= count) {
      return;
    }
    reorder(from, to);
  };

  const reset = () => {
    dragRef.current = null;
    overRef.current = null;
    setDragIndex(null);
    setOverIndex(null);
  };

  return (index: number): RowReorder => ({
    isDragging: dragIndex === index,
    isOver: overIndex === index && dragIndex !== null && dragIndex !== index,
    handleProps: {
      onPointerDown: (e) => {
        if (disabled) {
          return;
        }
        // テキスト選択・タッチスクロールを抑止し、このグリップに以降のポインタ移動/解放を集める。
        e.preventDefault();
        dragRef.current = index;
        overRef.current = index;
        setDragIndex(index);
        setOverIndex(index);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // setPointerCapture 非対応環境（jsdom など）では握りつぶす（D&D はブラウザでのみ動けばよい）。
        }
      },
      onPointerMove: (e) => {
        if (dragRef.current === null || typeof document === "undefined") {
          return;
        }
        // capture 中でも elementFromPoint は実座標の要素を返す。直下の行（data-reorder-index）をドロップ先に。
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const rowEl = target?.closest("[data-reorder-index]");
        if (!rowEl) {
          return;
        }
        const to = Number(rowEl.getAttribute("data-reorder-index"));
        if (!Number.isNaN(to)) {
          overRef.current = to;
          setOverIndex(to);
        }
      },
      onPointerUp: () => {
        const from = dragRef.current;
        const to = overRef.current;
        if (from !== null && to !== null) {
          move(from, to);
        }
        reset();
      },
      onKeyDown: (e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          move(index, index - 1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          move(index, index + 1);
        }
      },
    },
    rowProps: { "data-reorder-index": index },
  });
}

/**
 * D&D ドロップ後の**クライアント側 安定再ソート**（設計書 §5.1「同一ソートキー内並べ替え」）。サーバの
 * validate が強制ソート（予定=slot キー / 提出物=期限昇順・いずれも安定）を持つセクションでは、ドロップ直後に
 * 同じキーで並べ直して**見た目と保存結果を一致**させる（別バケットへ跨いだドロップはスナップバック）。
 *
 * 事前生成の**空行（prefill）は位置を保持**する: 実入力行（`!isBlank`）だけを取り出して `sortFilled`
 * （呼び出し側がサーバと同じ安定ソートを渡す）にかけ、元の実入力行スロットへ順に戻す。空行をソートに含めると
 * 既定キー（対象日・時限未選択）で実入力行の間へ滑り込み、レイアウトが跳ねて見えるため。元配列は破壊しない。
 */
export function resortFilledRows<T>(
  rows: T[],
  isBlank: (row: T) => boolean,
  sortFilled: (filled: T[]) => T[],
): T[] {
  const filledIndexes: number[] = [];
  const filled: T[] = [];
  rows.forEach((row, i) => {
    if (!isBlank(row)) {
      filledIndexes.push(i);
      filled.push(row);
    }
  });
  const sorted = sortFilled(filled);
  const next = rows.slice();
  filledIndexes.forEach((slot, j) => {
    const row = sorted[j];
    if (row !== undefined) {
      next[slot] = row;
    }
  });
  return next;
}

/**
 * 配列の `from` 番目を `to` 番目へ移す純関数（並べ替えの単一ソース）。範囲外/同一は元配列をそのまま返す
 * （= 参照同一で no-op、再描画を増やさない）。
 */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return items;
  }
  next.splice(to, 0, moved);
  return next;
}
