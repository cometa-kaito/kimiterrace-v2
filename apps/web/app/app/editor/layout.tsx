import type { ReactNode } from "react";

/**
 * エディタ配下（着地 / クラス別 / scope / ads / magic-link / quiet-hours）の共通キャンバス。
 *
 * 教員はナビが 1 項目のみでサイドバーが出ず `.admin-main` が全幅になるため、本文が画面端まで
 * 伸びて読みづらい（右の空白が機能しない）。ここで **中央寄せ + 最大幅** に統一し、着地（クラス選択）と
 * クラス別エディタを同じキャンバス幅に揃える（配置最適化）。モバイルは max-width に達しないので素直に全幅。
 *
 * 幅の根拠（2026-07-06 FHD 配置最適化）: 旧 1100px の主因だった「全画面チャットの 1 行が長すぎる」は
 * AI の浮遊パネル化（FloatingAiChat）で消滅した。教員の主要端末=職員室のフル HD デスクトップ（1920px）では
 * 1100px だと左右に約 400px ずつ死余白が出て、肝心の盤面プレビュー（50 インチ TV の縮小写像）が小さい。
 * 1400px へ広げ、2 カラム時の盤面 ≈650px / 編集 ≈700px を確保する（読み物系サブページの行長は
 * セクション内の表・入力欄の幅が支配するため過長にならない）。
 */
const CANVAS_MAX_WIDTH = "1400px";

export default function EditorCanvasLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: CANVAS_MAX_WIDTH, marginInline: "auto", width: "100%" }}>
      {children}
    </div>
  );
}
