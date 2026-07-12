/**
 * 教員向けアクション用の **依存ゼロ・インライン SVG アイコン**（音声入力 / ファイル / AI）。
 *
 * これまで 🎤 / 📄 / 🤖 の絵文字をアイコン代わりに使っていた箇所を、`nav-icons.tsx` と同じ
 * stroke ベース SVG に統一する（色は `currentColor` 継承・サイズは `1em` で隣接テキストに追従・
 * 装飾なので `aria-hidden`）。操作名はボタンのテキストが担う。
 *
 * 注: `aria-hidden` は **各 svg に直接**書く（`{...spread}` 経由だと biome の noSvgWithoutTitle が
 * 装飾判定できず誤検知するため）。
 */

/** マイク（音声入力）。 */
export function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "-0.15em" }}
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
    </svg>
  );
}

/** 書類（ファイルから取り込む）。 */
export function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "-0.15em" }}
    >
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M9 13h6M9 17h4" />
    </svg>
  );
}

/** AI（きらめき2つ＝おまかせ生成）。 */
export function AiIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "-0.15em" }}
    >
      <path d="M12 3.5 13.4 8.6 18.5 10 13.4 11.4 12 16.5 10.6 11.4 5.5 10 10.6 8.6Z" />
      <path d="M18 14 18.9 16.1 21 17 18.9 17.9 18 20 17.1 17.9 15 17 17.1 16.1Z" />
    </svg>
  );
}
