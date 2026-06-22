"use client";

import { type DragEvent, useState } from "react";

/**
 * エディタの可変フォーム行（連絡など、**配列順 = サイネージ表示順** のセクション）を手動で並べ替える
 * 純フック（D 群: 予定/連絡/提出物・来校者/呼び出しの並べ替え）。`reorder(from, to)` を呼ぶと配列を組み替え、
 * 行ごとの `handleProps`（ドラッグハンドル）/ `dropProps`（ドロップ先）/ `onMove`（上へ/下へ）を返す。
 *
 * ## 設計判断（学校管理 #1116 `useSiblingReorder` を踏襲）
 * - **マウス**: HTML5 ドラッグ&ドロップ（グリップを `draggable`、行を drop ターゲット）。
 * - **キーボード/タッチ**: 「上へ」「下へ」ボタン（D&D の代替経路）。色だけに依存しない（テキストボタン）。
 * - 永続化はこのフックでは行わない。呼び出し側（NoticeEditor 等）が並べ替え後の state を**既存の保存経路**
 *   （自動保存 / 手動保存）にそのまま流す。**配列順がそのまま保存・描画される連絡のみが対象**で、サーバが
 *   period/deadline/時刻で再ソートする予定・提出物・来校者・呼び出しは対象外（盤面の表示順を変えないため）。
 *
 * State はインデックス基準（行の安定キーはあくまで描画側が持つ）。並べ替え対象は同一リスト内に限る。
 */

/** 1 行ぶんの並べ替えハンドル（ドラッグ中/ドロップ先のフラグ・上下移動・grip / row へ撒く props）。 */
export type RowReorder = {
  /** この行をさらに上へ動かせるか（先頭でないか）。 */
  canUp: boolean;
  /** この行をさらに下へ動かせるか（末尾でないか）。 */
  canDown: boolean;
  /** この行を今ドラッグ中か（半透明表示などに使う）。 */
  isDragging: boolean;
  /** ドロップ先候補としてホバー中か（差し込み線ヒントに使う）。 */
  isOver: boolean;
  /** 上(-1)/下(+1)へ 1 つ移動（キーボード/タッチ経路）。 */
  onMove: (dir: -1 | 1) => void;
  /** ドラッグハンドル（グリップ）に撒く props。 */
  handleProps: {
    draggable: boolean;
    onDragStart: () => void;
    onDragEnd: () => void;
  };
  /** 行（ドロップ先）に撒く props。 */
  dropProps: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
};

/**
 * 並べ替えフック。`count` は現在の行数、`reorder(from, to)` は「from の行を to の位置へ移す」コールバック
 * （呼び出し側が自分の state を組み替える）。`disabled` 時はドラッグ/移動を無効化する（保存中など）。
 * `rowProps(index)` を各行へ渡す。
 */
export function useRowReorder(
  count: number,
  reorder: (from: number, to: number) => void,
  disabled = false,
): (index: number) => RowReorder {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    if (disabled || from === to || to < 0 || to >= count) {
      return;
    }
    reorder(from, to);
  };

  return (index: number): RowReorder => ({
    canUp: index > 0,
    canDown: index < count - 1,
    isDragging: dragIndex === index,
    isOver: overIndex === index && dragIndex !== null && dragIndex !== index,
    onMove: (dir) => move(index, index + dir),
    handleProps: {
      draggable: !disabled,
      onDragStart: () => setDragIndex(index),
      onDragEnd: () => {
        setDragIndex(null);
        setOverIndex(null);
      },
    },
    dropProps: {
      onDragOver: (e) => {
        if (dragIndex !== null) {
          e.preventDefault();
          setOverIndex(index);
        }
      },
      onDragLeave: () => setOverIndex((cur) => (cur === index ? null : cur)),
      onDrop: (e) => {
        e.preventDefault();
        if (dragIndex !== null) {
          move(dragIndex, index);
        }
        setDragIndex(null);
        setOverIndex(null);
      },
    },
  });
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
