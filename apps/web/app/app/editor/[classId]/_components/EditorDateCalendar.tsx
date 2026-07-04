"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./EditorDateCalendar.module.css";
import {
  EDITOR_CALENDAR_ANCHOR_ID,
  EDITOR_STACK_ANCHOR_ID,
  scrollToAnchor,
} from "./editor-anchors";

/**
 * クラスエディタ・計画ゾーンの**月カレンダー**（Client Component・editor-restructure-bulletin-2026-07.md §3.1）。
 *
 * 単一スタック化（同 §3）に伴い、旧「別の日も準備する」折りたたみ（`?plan=` を発行し下に第 2 の編集
 * スタックを出す方式）から、**対象日そのものを選ぶ**カレンダーに改めた。日付クリックは `?date=YYYY-MM-DD`
 * （scroll:false）のソフトナビで、上（ゾーン1）の単一編集スタックがその日へ切り替わる。ナビ反映後は
 * 編集スタック先頭（{@link EDITOR_STACK_ANCHOR_ID}）へ自動スクロールして「切り替わった」ことを見せる。
 *
 * - 旧折りたたみトグル・説明文 hint・クイックチップ（明日/あさって）は**廃止**（説明が要る時点で負け＝
 *   v2-ed47-6。直近の日は対象日セグメント {@link EditorDateSegments} が 1 タップで担う）。ここは常設で開く。
 * - 内容ドット（予定/連絡/提出物のある日）・過去日の無効化（選択中の日だけ例外的に押せる）は温存。
 * - 「今日」(`today`) と「選択した日」(`selectedDate`) はどちらもサーバから決定的に渡るので、強調表示は
 *   ハイドレーション不一致を起こさない。
 * - セグメント行の「📅 ほかの日」がここ（{@link EDITOR_CALENDAR_ANCHOR_ID}）へスクロールして開く。
 */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** `YYYY-MM-DD`（ゼロ詰め）を組む。`m0` は 0 始まりの月。 */
function toYmd(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function EditorDateCalendar({
  classId,
  today,
  selectedDate,
  contentDates,
}: {
  classId: string;
  /** サーバ（JST）で確定した今日（YYYY-MM-DD）。今日の強調に使う（決定的＝ハイドレーション安全）。 */
  today: string;
  /** 編集中の対象日（YYYY-MM-DD・サーバ決定値）。強調・aria-current を出す対象。 */
  selectedDate: string;
  /** 内容（予定 / 連絡 / 提出物）のある日（YYYY-MM-DD）。その日に点を打って俯瞰できるようにする。 */
  contentDates?: string[];
}) {
  const router = useRouter();
  // 内容のある日の集合（点の有無判定）。親（page.tsx）が選択月±1 か月ぶんを渡す。
  const contentSet = useMemo(() => new Set(contentDates ?? []), [contentDates]);

  // 直近にユーザーが選んだ日（自動スクロール待ち）。サーバ反映後に selectedDate がこの値になったら上の
  // 編集スタックへスクロールする。これにより「ユーザーが選んだ時だけ」スクロールし、初回ロード
  // （?date 付き URL を直接開く）や月送り（selectedDate 不変）では飛ばさない。
  const pendingScrollRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedDate && pendingScrollRef.current === selectedDate) {
      pendingScrollRef.current = null;
      scrollToAnchor(EDITOR_STACK_ANCHOR_ID);
    }
  }, [selectedDate]);

  // 表示中の年月（初期は選択日の月）。決定的なので SSR/クライアントで一致する。
  const initial = useMemo(() => {
    const [y, m] = (selectedDate || today).split("-").map(Number);
    return { y: y ?? 2026, m0: (m ?? 1) - 1 };
  }, [selectedDate, today]);
  const [view, setView] = useState(initial);
  // 別月の日付を選んだら表示月も追従する。
  useEffect(() => setView(initial), [initial]);

  const firstWeekday = new Date(view.y, view.m0, 1).getDay();
  const daysInMonth = new Date(view.y, view.m0 + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(d);
  }

  function shiftMonth(delta: number) {
    setView((v) => {
      const nd = new Date(v.y, v.m0 + delta, 1);
      return { y: nd.getFullYear(), m0: nd.getMonth() };
    });
  }
  // 日付確定の単一経路。選択中の日そのものは再ナビせず、上の編集スタックへ戻すだけ（空振り防止）。
  function go(ymd: string) {
    if (ymd === selectedDate) {
      scrollToAnchor(EDITOR_STACK_ANCHOR_ID);
      return;
    }
    // scroll: false で App Router 既定の「ページ先頭へスクロール」を抑止し、サーバ反映後に上の編集スタックへ
    // 自分でスクロールする（pendingScrollRef → useEffect）。
    pendingScrollRef.current = ymd;
    router.push(`/app/editor/${classId}?date=${ymd}`, { scroll: false });
  }

  return (
    <section id={EDITOR_CALENDAR_ANCHOR_ID} aria-label="月カレンダー" className={styles.card}>
      <div className={styles.body}>
        <div className={styles.head}>
          <button
            type="button"
            className={styles.nav}
            onClick={() => shiftMonth(-1)}
            aria-label="前の月"
          >
            ‹
          </button>
          <h3 className={styles.title}>
            {view.y}年{view.m0 + 1}月
          </h3>
          <button
            type="button"
            className={styles.nav}
            onClick={() => shiftMonth(1)}
            aria-label="次の月"
          >
            ›
          </button>
        </div>
        <div className={styles.week} aria-hidden="true">
          {WEEKDAYS.map((w, i) => (
            <span
              key={w}
              className={`${styles.wd} ${i === 0 ? styles.wdSun : ""} ${i === 6 ? styles.wdSat : ""}`}
            >
              {w}
            </span>
          ))}
        </div>
        <div className={styles.grid}>
          {cells.map((d, i) => {
            if (d === null) {
              // 月初の曜日合わせの空白セル（位置合わせのみ・固定）。
              // biome-ignore lint/suspicious/noArrayIndexKey: 固定の空白セル
              return <span key={`pad-${i}`} className={styles.empty} aria-hidden="true" />;
            }
            const ymd = toYmd(view.y, view.m0, d);
            const isToday = ymd === today;
            const isSelected = ymd === selectedDate;
            const hasContent = contentSet.has(ymd);
            // 過去日（昨日以前）は準備用途では押せない（薄く出す）。ただし選択中の日だけは例外的に押せるままにして
            // 「橙地に薄い文字」で潰れた見た目を避ける。
            const isPast = ymd < today;
            const disabled = isPast && !isSelected;
            return (
              <button
                key={ymd}
                type="button"
                className={`${styles.day} ${isToday ? styles.today : ""} ${isSelected ? styles.selected : ""} ${isPast ? styles.past : ""}`}
                aria-label={`${view.y}年${view.m0 + 1}月${d}日${isToday ? "・今日" : ""}${
                  hasContent ? "・内容あり" : ""
                }を編集`}
                aria-current={isSelected ? "date" : undefined}
                disabled={disabled}
                onClick={() => go(ymd)}
              >
                <span className={styles.dayNum}>{d}</span>
                <span
                  className={`${styles.dot} ${hasContent ? "" : styles.dotHidden}`}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
