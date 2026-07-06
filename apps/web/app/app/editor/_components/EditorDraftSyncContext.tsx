"use client";

import type { AssignmentItem, NoticeItem } from "@/lib/editor/notice-assignment-core";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import { createContext, useContext, useRef } from "react";

/**
 * エディタフォーム（WysiwygBoardEditor 配下の各セクション編集器）と会話 AI（EditorChat）の間で
 * 「**今この瞬間のフォーム状態**」を共有するための軽量ブリッジ（2026-07-06 P1: AI 反映⇄手入力の
 * 双方向非同期によるデータ消失の是正・片翼）。
 *
 * ## なぜ必要か（実証済みのデータ消失）
 * AI の下書き基底（EditorChat の `initialDraft`）は**ページロード時のスナップショット**だった。教員が
 * ロード後にフォームへ手入力（自動保存済み）してから AI に話しかけると、AI の下書きは手入力を知らない
 * 「完全な目標状態」になり、反映（per-section 置換保存）が**手入力を無警告で消す**（2026-07-06 本番で実証:
 * 手入力の「1限 数学」と連絡 1 件が AI 反映で消えた）。
 *
 * ## 設計: ref ベース（再レンダー非伝播）
 * フォームは編集のたび変わるが、AI 側が必要なのは**会話を始める瞬間の値だけ**（`rebaseDraftBeforeFirstTurn`）。
 * state で持つと編集のたびチャット側が再レンダーされるため、**MutableRef を配るだけ**にする（読み手が
 * 必要な時に `.current` を引く pull 型）。Provider 外（scope エディタ・単体テスト）では null を返し、
 * 呼び出し側は従来挙動（initialDraft 基底）に fail-soft する。
 */
export type EditorCurrentDraft = {
  schedules: ScheduleItem[];
  notices: NoticeItem[];
  assignments: AssignmentItem[];
};

type EditorDraftSyncRef = React.MutableRefObject<EditorCurrentDraft | null>;

const EditorDraftSyncContext = createContext<EditorDraftSyncRef | null>(null);

/** クラスエディタページ全体を包む Provider。DOM は生やさない（context のみ）。 */
export function EditorDraftSyncProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<EditorCurrentDraft | null>(null);
  return <EditorDraftSyncContext.Provider value={ref}>{children}</EditorDraftSyncContext.Provider>;
}

/**
 * 共有 ref を取得する。書き手（WysiwygBoardEditor）は編集のたび `.current` を更新し、読み手（EditorChat）は
 * 会話開始時に `.current` を読む。Provider 外では null（従来挙動へフォールバック）。
 */
export function useEditorDraftSyncRef(): EditorDraftSyncRef | null {
  return useContext(EditorDraftSyncContext);
}
