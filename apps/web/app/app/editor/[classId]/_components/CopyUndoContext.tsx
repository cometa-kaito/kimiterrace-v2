"use client";

import { type ReactNode, createContext, useContext, useState } from "react";

/**
 * コピーの「元に戻す（undo）」スナップショット 1 件分。`days` はコピー先の**コピー前**の内容
 * （`copyDayFromAction` / `copyPreviousWeekAction` が返す DaySnapshot[] と構造一致・date + 触ったブロックの
 * items）。`restoreCopySnapshotAction` にそのまま渡して復元する。
 */
export type CopyUndoSnapshot = { date: string; [block: string]: unknown };
export type CopyUndoEntry = {
  classId: string;
  /** この undo が有効な対象キー（day = "YYYY-MM-DD" / week = "week:<monday>"）。表示中の日/週と一致する時だけ出す。 */
  forKey: string;
  /** ボタン/メッセージ用の短い説明（例「7/6（月）へのコピー」）。 */
  label: string;
  days: CopyUndoSnapshot[];
};

type CopyUndoCtxValue = { undo: CopyUndoEntry | null; setUndo: (u: CopyUndoEntry | null) => void };
const CopyUndoCtx = createContext<CopyUndoCtxValue | null>(null);

/**
 * コピー undo スナップショットの保持所。**キー付き WysiwygBoardEditor の外側**（page.tsx の上位）に置くことで、
 * コピー成功時の `?copied=` ソフトナビ（配下エディタを再マウント）を跨いでもスナップショットがメモリに残り、
 * 再マウント後の {@link CopyFromMenu} が「元に戻す」を出せる（既存 EditorDraftSyncProvider と同じ「キーの上位で
 * 状態を持つ」手法）。**sessionStorage 等に永続化しない**（スナップショットは氏名等 PII を含みうるため、メモリ
 * 限定・タブ内のみ・次のコピー / 復元 / タブ閉じで消える＝ルール4 の趣旨に沿う）。
 */
export function CopyUndoProvider({ children }: { children: ReactNode }) {
  const [undo, setUndo] = useState<CopyUndoEntry | null>(null);
  return <CopyUndoCtx.Provider value={{ undo, setUndo }}>{children}</CopyUndoCtx.Provider>;
}

export function useCopyUndo(): CopyUndoCtxValue {
  const ctx = useContext(CopyUndoCtx);
  if (!ctx) {
    throw new Error("useCopyUndo は CopyUndoProvider の内側で使うこと");
  }
  return ctx;
}
