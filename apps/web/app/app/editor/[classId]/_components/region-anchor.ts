import type { EditRegion } from "@/app/(signage)/signage/[classToken]/_components/BoardRegionEditButton";

/**
 * 盤面クリック → 編集欄ジャンプ用の **DOM id 単一ソース**。
 *
 * 予定 / 連絡 / 提出物 の編集欄は {@link WysiwygBoardEditor} 配下にあり ref で参照できるが、来校者一覧 /
 * 生徒呼び出しの編集欄は親（page.tsx）が盤面の**外（下）**に出す別セクションなので、ref では届かない。
 * そこで該当セクションへ安定した DOM id を振り、`focusRegion` から `document.getElementById` で参照して
 * スクロール + フォーカスする。id 文字列が編集欄側（VisitorsEditor / CalloutsEditor）とジャンプ側
 * （WysiwygBoardEditor）で drift しないよう、ここを唯一の生成元にする。
 */
export function editorRegionAnchorId(region: EditRegion): string {
  return `editor-region-${region}`;
}
