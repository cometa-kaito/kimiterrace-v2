"use client";

import { tokens } from "@kimiterrace/ui";
import { type ReactNode, useState } from "react";

const { color, radius, fontSize } = tokens;

/**
 * クラスエディタの**タブ shell**（finding 2b・モック `teacher_ai_fullscreen_first` 準拠）。
 *
 * 「AIで作る（会話型 {@link EditorChat}）/ 盤面を編集（各セクションエディタ）/ プレビュー」をタブで切替える。
 * **開いた瞬間は AI タブが既定**（話して作るを主役に）。各タブの中身は **server で描画した slot** を
 * そのまま受け取り（client に server children を渡す Next.js パターン）、本 component は表示の出し分けだけを
 * 担う（"use client"・状態はタブ選択のみ）。
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
    <div>
      <div role="tablist" aria-label="エディタの表示切替" style={tabBarStyle}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              style={active ? activeTabStyle : tabStyle}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div style={tab === "ai" ? undefined : hiddenStyle}>{ai}</div>
      <div style={tab === "board" ? undefined : hiddenStyle}>{board}</div>
      <div style={tab === "preview" ? undefined : hiddenStyle}>{preview}</div>
    </div>
  );
}

const hiddenStyle: React.CSSProperties = { display: "none" };
const tabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  padding: "0.25rem",
  marginBottom: "1rem",
  background: color.bgSoft,
  borderRadius: radius.md,
};
const tabStyle: React.CSSProperties = {
  flex: 1,
  minHeight: "40px",
  padding: "0.4rem 0.8rem",
  border: "none",
  borderRadius: radius.sm,
  background: "transparent",
  color: color.muted,
  fontSize: fontSize.sm,
  fontWeight: 600,
  cursor: "pointer",
};
const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  background: "#fff",
  color: color.ink,
  border: `1px solid ${color.border}`,
};
