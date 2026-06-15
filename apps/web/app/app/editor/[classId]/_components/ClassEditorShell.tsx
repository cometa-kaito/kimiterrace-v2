"use client";

import { type ReactNode, useState } from "react";
import styles from "./ClassEditorShell.module.css";

/**
 * クラス / scope エディタの**タブ shell**（finding 2b・モック `teacher_ai_fullscreen_first` 準拠）。
 *
 * 「AIで作る（会話型 {@link EditorChat}）/ 盤面を編集（各セクションエディタ）/ プレビュー」をタブで切替える。
 * **開いた瞬間は AI タブが既定**（話して作るを主役に）。各タブの中身は **server で描画した slot** を
 * そのまま受け取り（client に server children を渡す Next.js パターン）、本 component は表示の出し分けだけを
 * 担う（"use client"・状態はタブ選択のみ）。
 *
 * **レスポンシブ（UIUX）**: デスクトップは上部タブ、モバイル(≤640px)では親指で届く**画面下の固定ボトムナビ**に
 * する（{@link file://./ClassEditorShell.module.css} の media query）。フォーム入力中でもタブ移動が容易。
 *
 * **非アクティブタブは display:none で**保持する（unmount しない）。タブ往復で会話の途中・盤面の未保存
 * 入力を失わないため（編集器は client・state を持つ）。
 */
const TABS = [
  { key: "ai", label: "AIで作る" },
  { key: "board", label: "盤面を編集" },
  { key: "preview", label: "プレビュー" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const hiddenStyle: React.CSSProperties = { display: "none" };

export function ClassEditorShell({
  ai,
  board,
  preview,
  defaultTab = "ai",
}: {
  ai: ReactNode;
  board: ReactNode;
  preview: ReactNode;
  defaultTab?: TabKey;
}) {
  const [tab, setTab] = useState<TabKey>(defaultTab);
  return (
    <div className={styles.shell}>
      <div role="tablist" aria-label="エディタの表示切替" className={styles.tabBar}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`editor-tab-${t.key}`}
              aria-selected={active}
              aria-controls={`editor-panel-${t.key}`}
              className={styles.tab}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="editor-panel-ai"
        aria-labelledby="editor-tab-ai"
        style={tab === "ai" ? undefined : hiddenStyle}
      >
        {ai}
      </div>
      <div
        role="tabpanel"
        id="editor-panel-board"
        aria-labelledby="editor-tab-board"
        style={tab === "board" ? undefined : hiddenStyle}
      >
        {board}
      </div>
      <div
        role="tabpanel"
        id="editor-panel-preview"
        aria-labelledby="editor-tab-preview"
        style={tab === "preview" ? undefined : hiddenStyle}
      >
        {preview}
      </div>
    </div>
  );
}
