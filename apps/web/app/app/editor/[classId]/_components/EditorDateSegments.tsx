"use client";

import { useRouter } from "next/navigation";
import styles from "./EditorDateSegments.module.css";
import { EDITOR_CALENDAR_ANCHOR_ID, scrollToAnchor } from "./editor-anchors";

/**
 * 対象日セグメント（単一スタック化・editor-restructure-bulletin-2026-07.md §3.1）。
 *
 * 編集スタックは常に 1 つで、このセグメントで対象日を切り替えると、盤面プレビュー・編集セクション・
 * AI FAB・前日コピーがすべてその日に追随する（`?date=` ソフトナビ → page.tsx の `key={date}:{copied}` で
 * 配下エディタが再マウント＝混線バグ規律は維持）。
 *
 * - 並びは**時系列**: 今日（授業日でなくても常に先頭＝「今日の盤面に何が映っているか」の確認用途を殺さない）
 *   → 翌授業日 → その次の授業日…（サーバの {@link editorDateSegments} が決定・ハイドレーション安全）。
 * - 各セグメントは曜日つき、翌授業日には「翌授業日」バッジを添える。選択中は `aria-current="date"`。
 * - カレンダーで選んだ日がセグメント列に無いときは、その日を追加チップとして時系列位置に挿し込む
 *   （「編集中の日がセグメント行に見えない」を作らない）。
 * - 「📅 ほかの日」はゾーン2（計画）の月カレンダー（{@link EDITOR_CALENDAR_ANCHOR_ID}）へスクロールする
 *   （旧「別の日も準備する」折りたたみトグルは廃止・任意日はカレンダーが担う）。
 */

const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-07-06" → "7/6（月）"。曜日は日付から決まる（決定的＝ハイドレーション安全）。不正はそのまま返す。 */
function shortLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) {
    return date;
  }
  const weekday = WEEKDAY_JP[new Date(y, m - 1, d).getDay()] ?? "";
  return `${m}/${d}（${weekday}）`;
}

export function EditorDateSegments({
  classId,
  today,
  selectedDate,
  segmentDates,
}: {
  classId: string;
  /** サーバ（JST）で確定した今日（YYYY-MM-DD）。「今日」ラベルの判定に使う（決定的）。 */
  today: string;
  /** 編集中の対象日（YYYY-MM-DD・サーバ決定値）。 */
  selectedDate: string;
  /** セグメントの日付列（時系列・今日が先頭）。サーバの `editorDateSegments` が決定する。 */
  segmentDates: string[];
}) {
  const router = useRouter();
  // カレンダーで選んだ日がセグメント列外なら、時系列位置に挿し込んで「編集中の日は必ず行に見える」を保つ。
  const dates = segmentDates.includes(selectedDate)
    ? segmentDates
    : [...segmentDates, selectedDate].sort();
  // 「翌授業日」バッジ = 今日の次に並ぶ最初の授業日（サーバ列で今日の直後の要素）。
  const nextSchool = segmentDates[1];

  function go(date: string) {
    if (date === selectedDate) {
      return;
    }
    // scroll:false で App Router 既定の「ページ先頭へスクロール」を抑止する（セグメント行は既に視界内）。
    router.push(`/app/editor/${classId}?date=${date}`, { scroll: false });
  }

  // スクロールアンカー（EDITOR_STACK_ANCHOR_ID）はこの nav ではなく親（page.tsx のゾーン1 section）に付ける。
  // この nav は #1237 以降 sticky バー内にあり常に視界内のため、scrollIntoView が「既に見えている」と判定して
  // 空振りする（カレンダー選択後に編集エリアへ戻れない実バグ・2026-07-06 実画面監査）。
  return (
    <nav aria-label="対象日" className={styles.row}>
      {dates.map((date) => {
        const isSelected = date === selectedDate;
        const isToday = date === today;
        const label = shortLabel(date);
        return (
          <button
            key={date}
            type="button"
            className={`${styles.segment} ${isSelected ? styles.selected : ""}`}
            aria-current={isSelected ? "date" : undefined}
            aria-label={`${label}${isToday ? "・今日" : ""}${date === nextSchool ? "・翌授業日" : ""}を編集`}
            onClick={() => go(date)}
          >
            {isToday ? <span className={styles.todayPrefix}>今日</span> : null}
            {label}
            {date === nextSchool ? <span className={styles.badge}>翌授業日</span> : null}
          </button>
        );
      })}
      <button
        type="button"
        className={styles.segment}
        aria-label="ほかの日を選ぶ（月カレンダーを開く）"
        onClick={() => scrollToAnchor(EDITOR_CALENDAR_ANCHOR_ID)}
      >
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
          style={{ verticalAlign: "-0.15em", marginRight: "0.3rem" }}
        >
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v4M16 3v4" />
        </svg>
        ほかの日
      </button>
    </nav>
  );
}
