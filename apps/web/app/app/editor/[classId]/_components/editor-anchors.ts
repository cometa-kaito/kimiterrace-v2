/**
 * クラスエディタ内スクロールのアンカー id（単一スタック化・editor-restructure-bulletin-2026-07.md §3.1）。
 *
 * {@link EDITOR_STACK_ANCHOR_ID} は上（ゾーン1）の編集スタック先頭＝ゾーン1 の section（page.tsx・非 sticky。
 * 旧はセグメント nav だったが sticky バー内に入り scrollIntoView が空振りするため #1248 で移設）。月カレンダー
 * （ゾーン2）で日付を選んだ後にここへ戻す。{@link EDITOR_CALENDAR_ANCHOR_ID} はゾーン2の月カレンダーで、
 * セグメントの「📅 ほかの日」が開く先。両コンポーネント（EditorDateSegments / EditorDateCalendar）が
 * 相互参照すると循環 import になるため、id はこの最小モジュールに集約する。
 */
export const EDITOR_STACK_ANCHOR_ID = "editor-day-stack";
export const EDITOR_CALENDAR_ANCHOR_ID = "editor-month-calendar";

/** 画面内へ滑らかにスクロール（jsdom 等の非実装環境では `?.` でフォールバックして no-op）。 */
export function scrollToAnchor(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}
