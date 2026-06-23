"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import styles from "./EditorDateCalendar.module.css";

/**
 * クラスエディタの「先の日を選んで編集」月カレンダー（**Client Component**・折りたたみ式）。
 *
 * 上の「今日の編集」とは別に、カレンダーで**先の日付を選ぶと、その日の編集欄が下（page.tsx の「選択した日の編集」）に
 * 出る**（要望 2026-06-23: 今日と未来を別セクションに分ける）。クリックは `?plan=YYYY-MM-DD`（scroll:false）に乗せる＝
 * ページが再描画され、下の選択日エディタが `key={plan}` で初期化される（今日の編集＝上は動かさない）。
 *
 * **折りたたみ（要望 2026-06-23）**: 普段は畳んでヘッダー（`▸ 先の日を選んで編集`）だけ出し、使いたいときに開く。
 * 既定は畳む。ただし編集中（`selectedDate`=?plan あり）のときは開いて出す（使用中は開けておく）。`selectedDate` は
 * サーバ決定値なので開閉初期値もハイドレーション安全。一度開けば、日付選択（?plan ソフトナビ）では本コンポーネントは
 * 再マウントされない＝開いたまま保たれる。畳んでいる間に編集中の日があればヘッダーに「（◯月◯日 を編集中）」を併記する。
 *
 * 「今日」(`today`) と「選択した日」(`selectedDate`) はどちらもサーバから決定的に渡るので、強調表示は
 * ハイドレーション不一致を起こさない（今日はサーバ JST 確定値・選択日は `?plan`）。
 */
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** `YYYY-MM-DD`（ゼロ詰め）を組む。`m0` は 0 始まりの月。 */
function toYmd(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "2026-06-26" → "6月26日"（畳んだヘッダーの「編集中」表示用の短い日付）。 */
function formatShort(date: string): string {
  const parts = date.split("-");
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

export function EditorDateCalendar({
  classId,
  today,
  selectedDate,
  contentDates,
}: {
  classId: string;
  /** サーバ（JST）で確定した今日（YYYY-MM-DD）。今日の強調と初期表示月に使う（決定的＝ハイドレーション安全）。 */
  today: string;
  /** 編集中の「選択した日（先の日）」（YYYY-MM-DD）。未選択なら undefined。点・aria-current を出す対象。 */
  selectedDate?: string;
  /** 内容（予定 / 連絡 / 提出物）のある日（YYYY-MM-DD）。その日に点を打って俯瞰できるようにする。 */
  contentDates?: string[];
}) {
  const router = useRouter();
  // 内容のある日の集合（点の有無判定）。親（page.tsx）が選択月±1 か月ぶんを渡す。
  const contentSet = useMemo(() => new Set(contentDates ?? []), [contentDates]);

  // 折りたたみ: 既定は**開く**（要望 2026-06-23: 初見ユーザーがカレンダーに気づけるように）。
  // 日付選択は ?plan ソフトナビ（本コンポーネントは再マウントしない）なので、一度閉じた状態はそのまま保たれる。
  const [open, setOpen] = useState(true);

  // 表示中の年月（初期は選択日があればその月・無ければ今日の月）。どちらも決定的なので SSR/クライアントで一致する。
  const initial = useMemo(() => {
    const [y, m] = (selectedDate ?? today).split("-").map(Number);
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
  function pick(d: number) {
    // scroll: false で App Router 既定の「ページ先頭へスクロール」を抑止する。先の日付を選んでも一番上（今日の
    // 編集）へ飛ばず、カレンダーの位置を保ったまま下の「選択した日の編集」がその場で切り替わる（要望 2026-06-23:
    // 日付クリックで最上部に飛んで見にくい、の是正。ScheduleEditor の対象日切替と同じ作法）。
    router.push(`/app/editor/${classId}?plan=${toYmd(view.y, view.m0, d)}`, { scroll: false });
  }

  return (
    <section aria-label="先の日を選んで編集" className={styles.card}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={styles.toggleIcon} aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        先の日を選んで編集
        {!open && selectedDate ? (
          <span className={styles.toggleSelected}>（{formatShort(selectedDate)} を編集中）</span>
        ) : null}
      </button>
      {open ? (
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
          <p className={styles.hint}>先の日付を選ぶと、下に「選択した日の編集」が出ます。</p>
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
        </div>
      ) : null}
    </section>
  );
}
