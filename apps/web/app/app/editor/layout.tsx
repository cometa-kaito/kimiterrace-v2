import type { ReactNode } from "react";

/**
 * エディタ配下（着地 / クラス別 / scope / ads / magic-link / quiet-hours）の共通キャンバス。
 *
 * 教員はナビが 1 項目のみでサイドバーが出ず `.admin-main` が全幅になるため、本文が画面端まで
 * 伸びて読みづらい（チャット 1 行が長すぎる・右の空白が機能しない）。ここで **中央寄せ + 最大幅** に
 * 統一し、着地（クラス選択）とクラス別エディタを同じキャンバス幅に揃える（配置最適化）。PC では
 * AI タブの 2 ペインを置ける幅を確保し、モバイルは max-width に達しないので素直に全幅になる。
 */
const CANVAS_MAX_WIDTH = "1100px";

export default function EditorCanvasLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: CANVAS_MAX_WIDTH, marginInline: "auto", width: "100%" }}>
      {children}
    </div>
  );
}
