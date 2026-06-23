"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import styles from "./EditorDateCalendar.module.css";

/**
 * クラスエディタ最下部の「日付を選んで編集」月カレンダー（**Client Component**）。
 *
 * 旧来この画面には日付ナビ UI が無く、対象日は `?date=` の手打ちでしか変えられなかった。常設の月カレンダーを
 * 置き、**日付をクリックするとその日の編集に切り替わる**（要望 2026-06-23）。クリックは既存の対象日ルーティング
 * （`/app/editor/{classId}?date=YYYY-MM-DD`）にそのまま乗せる＝ページが新しい対象日で再描画され、各エディタは
 * `key={date}` で新日付のデータに再初期化される（基本のエディタ画面・保存/検証/RLS はそのまま）。
 *
 * 「今日」の強調はマウント後に JST で確定する（SSR とクライアントの時差によるハイドレーション不一致を避ける・
 * `WysiwygBoardEditor` の実時計と同じ作法）。「編集中の日」は決定的な `selectedDate` から描くので不一致しない。
 */
const JST = "Asia/Tokyo";
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** `YYYY-MM-DD`（ゼロ詰め）を組む。`m0` は 0 始まりの月。 */
function toYmd(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function EditorDateCalendar({
  classId,
  selectedDate,
  contentDates,
}: {
  classId: string;
  selectedDate: string;
  /** 内容（予定 / 連絡 / 提出物）のある日（YYYY-MM-DD）。その日に点を打って俯瞰できるようにする。 */
  contentDates?: string[];
}) {
  const router = useRouter();
  // 内容のある日の集合（点の有無判定）。親（page.tsx）が選択月±1 か月ぶんを渡す。
  const contentSet = useMemo(() => new Set(contentDates ?? []), [contentDates]);

  // 「今日」はマウント後に JST で確定（SSR/クライアントの時差での不一致回避）。確定までは今日強調なしで描く。
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    setToday(new Date().toLocaleDateString("en-CA", { timeZone: JST }));
  }, []);

  // 表示中の年月（初期は選択日の月）。selectedDate は決定的なので SSR/クライアントで一致する。
  const initial = useMemo(() => {
    const [y, m] = selectedDate.split("-").map(Number);
    return { y: y ?? 2026, m0: (m ?? 1) - 1 };
  }, [selectedDate]);
  const [view, setView] = useState(initial);
  // 別月の日付へ移動したら（selectedDate が別月になったら）表示月も追従する。
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
  function pick(d: number) {
    router.push(`/app/editor/${classId}?date=${toYmd(view.y, view.m0, d)}`);
  }

  return (
    <section aria-label="日付を選んで編集" className={styles.card}>
      <div className={styles.head}>
        <button
          type="button"
          className={styles.nav}
          onClick={() => shiftMonth(-1)}
          aria-label="前の月"
        >
          ‹
        </button>
        <h2 className={styles.title}>
          {view.y}年{view.m0 + 1}月
        </h2>
        <button
          type="button"
          className={styles.nav}
          onClick={() => shiftMonth(1)}
          aria-label="次の月"
        >
          ›
        </button>
      </div>
      <p className={styles.hint}>日付を選ぶと、その日の内容を編集できます。</p>
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
          return (
            <button
              key={ymd}
              type="button"
              className={`${styles.day} ${isToday ? styles.today : ""} ${isSelected ? styles.selected : ""}`}
              aria-label={`${view.y}年${view.m0 + 1}月${d}日${isToday ? "・今日" : ""}${
                hasContent ? "・内容あり" : ""
              }を編集`}
              aria-current={isSelected ? "date" : undefined}
              onClick={() => pick(d)}
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
    </section>
  );
}
