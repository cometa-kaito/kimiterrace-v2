"use client";

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef } from "react";

/**
 * 可変フォーム行（テーブル / リスト）の入力セルで **Tab を縦移動**にする共有フック（スプレッドシート風の
 * 連続入力）。予定・連絡・提出物・来校者・呼び出しエディタで共有する（`_components` 内の共有フックという点で
 * {@link useRowReorder} と同じ立ち位置）。元は ScheduleEditor のインライン実装で、横展開のため切り出した
 * （要望 2026-06-23: 連絡・提出物などコンテンツ編集でも Tab で下へ）。
 *
 * - **Tab**: 同じ列（col）の次の行（row+1）の同じ列セルへフォーカス。最終行なら `addRow()` を呼んで行を足し、
 *   描画後に新しい行の同じ列へフォーカスする（行追加は非同期に反映されるため pendingFocus + 行数変化 effect で当てる）。
 * - **Shift+Tab**: 同じ列の前の行（row-1）へ。先頭行（row=0）では既定動作に委ねる（preventDefault しない＝
 *   フォーカストラップを作らず、前の列 / 前要素へ普通に抜けられる）。
 * - 登録されていないセル（削除ボタン・日付 / 時刻の native ピッカー等）には介入しない＝ブラウザ既定のタブ順のまま。
 *   `<input type="date">` / `type="time"` は内部セグメント間 Tab を残したいので、呼び出し側で登録しないこと。
 * - **移動先セルが未登録**（例: 詳細パネル内の列で、次 / 前の行のパネルが閉じている・#1256）のときも介入しない＝
 *   preventDefault せずブラウザ既定の Tab に委ねる。preventDefault した後にフォーカス先が無い「Tab の握り潰し」を
 *   作らない。常時表示のコア列（全行で登録される）はこの分岐に入らないので従来挙動のまま。
 * - **行によっては存在しない列**（詳細パネル内・条件付き表示の入力）を登録する場合は、`onCellKeyDown` に
 *   `{ addRowOnLastRow: false }` を渡すこと。最終行の Tab で行を追加しても新規行にその列は存在せず
 *   （パネルは閉じて生まれる）、フォーカス先の無い空行だけが増えるため、行追加せず既定動作に委ねる。
 *
 * `col` は**論理列番号**で、DOM の列順と一致する必要はない（`registerCell` と `onCellKeyDown` で同じ値を使えばよい）。
 * 例: 日付 / 時刻列を介入対象から外し、テキスト列だけに 0,1,2.. を割り当てる。
 *
 * 保存 / 検証 / RLS / 監査の挙動には一切触れない（フォーカス制御のみ）。jsdom など focus 可能な環境でテストできる。
 *
 * @param rowCount 現在の行数（最終行判定・行追加後の pendingFocus 起動条件）。各エディタの `rows.length` を渡す。
 * @param addRow 最終行で Tab を押したときに 1 行追加するコールバック（各エディタ既存の addRow）。
 */
export function useGridTabNavigation(
  rowCount: number,
  addRow: () => void,
): {
  registerCell: (row: number, col: number, el: HTMLElement | null) => void;
  onCellKeyDown: (
    e: ReactKeyboardEvent<HTMLElement>,
    row: number,
    col: number,
    opts?: {
      /**
       * 最終行の Tab で `addRow()` を発火させるか（既定 true＝従来挙動）。新規行に**存在しない列**
       * （詳細パネル内の欄など）は false を渡す＝行追加せずブラウザ既定の Tab に委ねる。
       */
      addRowOnLastRow?: boolean;
    },
  ) => void;
} {
  // 入力セルを `row:col` でキー登録した ref マップ。Tab で同じ列の次の行へフォーカスを移す。
  const cellRefs = useRef(new Map<string, HTMLElement>());
  // 新規行追加直後にフォーカスしたいセル（addRow は非同期に行が増えるため、描画後 effect で当てる）。
  const pendingFocusRef = useRef<{ row: number; col: number } | null>(null);

  const registerCell = useCallback((row: number, col: number, el: HTMLElement | null) => {
    const key = `${row}:${col}`;
    if (el) {
      cellRefs.current.set(key, el);
    } else {
      cellRefs.current.delete(key);
    }
  }, []);

  const focusCell = useCallback((row: number, col: number): boolean => {
    const el = cellRefs.current.get(`${row}:${col}`);
    if (el) {
      el.focus();
      return true;
    }
    return false;
  }, []);

  // 移動先セルが登録されているか。**preventDefault する前**に確認する（未登録なら介入せず既定 Tab に委ねる）。
  const hasCell = useCallback(
    (row: number, col: number): boolean => cellRefs.current.has(`${row}:${col}`),
    [],
  );

  // 行数が変わった後（addRow で増えた直後）に保留中のフォーカスを当てる。当たらなければ何もしない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 行数(rowCount)変化を effect の起動条件にする
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending && focusCell(pending.row, pending.col)) {
      pendingFocusRef.current = null;
    }
  }, [rowCount, focusCell]);

  // セルの Tab を縦移動にする。Tab=同 col の次行 / Shift+Tab=同 col の前行。最終行で Tab を押したら新規行を
  // 追加して同 col にフォーカス（連続入力を速く）。先頭行で Shift+Tab は既定動作に委ねる（フォーカストラップを
  // 作らない＝削除ボタンや画面外への離脱を妨げない）。移動先セルが未登録（次 / 前の行に同じ欄が出ていない・
  // 詳細パネル閉など）のときも preventDefault せず既定動作に委ねる（#1256: フォーカス先の無い握り潰しを作らない）。
  const onCellKeyDown = useCallback(
    (
      e: ReactKeyboardEvent<HTMLElement>,
      row: number,
      col: number,
      opts?: { addRowOnLastRow?: boolean },
    ) => {
      if (e.key !== "Tab") {
        return;
      }
      if (e.shiftKey) {
        // 前の行の同じ列へ。先頭行、または前の行に同じ欄が無い（未登録）なら既定動作（前の列 / 前要素へ）に委ねる。
        if (row > 0 && hasCell(row - 1, col)) {
          e.preventDefault();
          focusCell(row - 1, col);
        }
        return;
      }
      if (row < rowCount - 1) {
        // 下の行の同じ列へ。次の行に同じ欄が無い（未登録）なら介入しない＝既定の Tab 順のまま。
        if (hasCell(row + 1, col)) {
          e.preventDefault();
          focusCell(row + 1, col);
        }
        return;
      }
      // 最終行: 常在列は新規行を追加して同 col にフォーカスする。新規行に存在しない列
      // （addRowOnLastRow: false）は行を足さず既定動作に委ねる（新規行のパネルは閉じておりフォーカス先が無い）。
      if (opts?.addRowOnLastRow === false) {
        return;
      }
      e.preventDefault();
      pendingFocusRef.current = { row: row + 1, col };
      addRow();
    },
    [rowCount, focusCell, hasCell, addRow],
  );

  return { registerCell, onCellKeyDown };
}
