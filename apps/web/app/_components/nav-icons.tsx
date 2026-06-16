import type { ReactElement } from "react";

/**
 * サイドナビ用の **依存ゼロ・インライン SVG アイコン集**（2026-06-17 デザイン刷新）。
 *
 * アイコンライブラリ（lucide 等）を新規依存に足さず、必要な分だけ stroke ベースの軽量 SVG を持つ。
 * 色は `currentColor`（リンクの色を継承＝active 時は白、通常は muted）に統一し、`aria-hidden` で
 * 装飾扱い（操作名はリンクのテキストが担う）。サイズは 18px 固定で nav テキストと縦中央そろえ。
 *
 * キーは `lib/nav.ts` の `NavItem.icon`（文字列）と対応。未知キー / 未指定は `null`（アイコン無しで
 * フォールバック＝壊れない）。
 */

/** アイコンキー → SVG の内側要素（path/circle 等）。viewBox は共通 24x24。 */
const ICONS: Record<string, ReactElement> = {
  // 学校一覧 / 学校管理
  building: (
    <>
      <path d="M3 21h18" />
      <path d="M6 21V8l6-4 6 4v13" />
      <path d="M10 21v-5h4v5" />
    </>
  ),
  // 教職員管理
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5" />
      <path d="M21 20a5 5 0 0 0-4-4.9" />
    </>
  ),
  // 学校設定
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>
  ),
  // 全校ダッシュボード
  chart: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6" />
    </>
  ),
  // 月次レポート
  file: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  // 広告配信割当
  megaphone: (
    <>
      <path d="M4 11v2a1 1 0 0 0 1 1h2l5 4V6L7 10H5a1 1 0 0 0-1 1z" />
      <path d="M16 9a3 3 0 0 1 0 6" />
    </>
  ),
  // 公開履歴
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  // モニタ設定
  tv: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="1" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  // センサー管理
  sensor: (
    <>
      <path d="M5 12a10 10 0 0 1 14 0" />
      <path d="M8.5 15a5 5 0 0 1 7 0" />
      <path d="M12 18.5h.01" />
    </>
  ),
  // TVコマンド履歴
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  // TVダウンタイム
  alert: (
    <>
      <path d="M12 3 21 19H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  // 監査ログ
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  // イベント生ログ
  list: (
    <>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  // AIチャット監査
  message: (
    <>
      <path d="M4 5h16v11H8l-4 4z" />
      <path d="M9 10h6M9 13h4" />
    </>
  ),
  // フィードバック
  feedback: (
    <>
      <path d="M4 5h16v10H7l-3 3z" />
      <path d="M8 10h.01M12 10h.01M16 10h.01" />
    </>
  ),
  // パスワード変更
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l2 2M14 9l2 2" />
    </>
  ),
  // エディタ
  edit: (
    <>
      <path d="M4 20h4L18 10l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
};

/** nav アイコンを返す。未指定 / 未知キーは null（アイコン無しで描画、レイアウトは壊さない）。 */
export function navIcon(name?: string): ReactElement | null {
  if (!name) {
    return null;
  }
  const inner = ICONS[name];
  if (!inner) {
    return null;
  }
  return (
    <svg
      className="admin-nav__icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {inner}
    </svg>
  );
}
