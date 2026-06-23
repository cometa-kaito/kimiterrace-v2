"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./EditorDateCalendar.module.css";

/**
 * クラスエディタの「別の日も準備する」月カレンダー（**Client Component**・折りたたみ式）。
 *
 * エディタの主役はあくまで上の「今日の編集」で、本コンポーネントはその**付属（add-on）**。先の日付を選ぶと、その日の
 * 編集欄が下（page.tsx の「選択した日の編集」）に出る（要望 2026-06-23: 今日と未来を別セクションに分ける）。クリックは
 * `?plan=YYYY-MM-DD`（scroll:false）に乗せ、ページ再描画後に**生成された下の編集欄へ自動スクロール**する（要望
 * 2026-06-23: 選んでも下に出た欄まで自分でスクロールするのが手間、の是正）。今日の編集（上）は動かさない。
 *
 * **使い勝手の改善（要望 2026-06-23）**:
 *   - **クイックチップ「明日 / あさって」**: 最頻ケース（明日の準備）は月グリッドを開かず 1 タップ。畳んでいても押せるよう
 *     本体（月グリッド）の外＝ヘッダー行に常設する。
 *   - **トグルをボタン然と**: 旧 `▸ …` の素テキストは付属機能だと気づきにくいので枠つきボタンにする。
 *   - **今日クリックの空振り解消**: 月グリッドで「今日」を押しても `?plan` は今日と同じで下に何も出ない（page.tsx で
 *     plan=null）。代わりに上の「今日の編集」へスクロールして戻す（{@link TODAY_ANCHOR_ID}）。
 *   - **過去日は無効化**: 準備用途なので昨日以前は押せない・薄く出す（内容ドットは残す）。選択中の日だけは例外的に
 *     押せるままにして潰れた見た目（橙地に薄文字）を避ける。
 *
 * **折りたたみ**: 普段は畳んでヘッダー（`▸ 別の日も準備する`）＋チップだけ出し、使いたいときに開く。既定は畳む。ただし
 * 編集中（`selectedDate`=?plan あり）のときは開いて出す。`selectedDate` はサーバ決定値なので開閉初期値もハイドレーション
 * 安全。一度開けば、日付選択（?plan ソフトナビ）では本コンポーネントは再マウントされない＝開いたまま保たれる。畳んで
 * いる間に編集中の日があればヘッダーに「（◯月◯日 を編集中）」を併記する。
 *
 * 「今日」(`today`) と「選択した日」(`selectedDate`) はどちらもサーバから決定的に渡るので、強調表示は
 * ハイドレーション不一致を起こさない（今日はサーバ JST 確定値・選択日は `?plan`）。
 */

/** 下「選択した日の編集」セクションのアンカー id（選択後に自動スクロールする先・page.tsx と共有）。 */
export const SELECTED_DAY_ANCHOR_ID = "editor-selected-day";
/** 上「今日の編集」セクションのアンカー id（今日クリック時に戻る先・page.tsx と共有）。 */
export const TODAY_ANCHOR_ID = "editor-today";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** `YYYY-MM-DD`（ゼロ詰め）を組む。`m0` は 0 始まりの月。 */
function toYmd(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` を n 日進めた `YYYY-MM-DD`。チップ（明日 / あさって）は `today` から決定的に出す＝ハイドレーション安全。 */
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y ?? 2026, (m ?? 1) - 1, (d ?? 1) + n);
  return toYmd(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/** "2026-06-26" → "6月26日"（畳んだヘッダーの「編集中」表示用の短い日付）。 */
function formatShort(date: string): string {
  const parts = date.split("-");
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

/** 画面内へ滑らかにスクロール（jsdom 等の非実装環境では `?.` でフォールバックして no-op）。 */
function scrollToAnchor(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

export function EditorDateCalendar({
  classId,
  today,
  selectedDate,
  contentDates,
}: {
  classId: string;
  /** サーバ（JST）で確定した今日（YYYY-MM-DD）。今日の強調・初期表示月・チップ（明日/あさって）に使う（決定的＝ハイドレーション安全）。 */
  today: string;
  /** 編集中の「選択した日（先の日）」（YYYY-MM-DD）。未選択なら undefined。点・aria-current を出す対象。 */
  selectedDate?: string;
  /** 内容（予定 / 連絡 / 提出物）のある日（YYYY-MM-DD）。その日に点を打って俯瞰できるようにする。 */
  contentDates?: string[];
}) {
  const router = useRouter();
  // 内容のある日の集合（点の有無判定）。親（page.tsx）が選択月±1 か月ぶんを渡す。
  const contentSet = useMemo(() => new Set(contentDates ?? []), [contentDates]);

  // 折りたたみ: 既定は畳む。編集中（selectedDate あり）なら開いて出す。初期値は決定的なのでハイドレーション安全。
  // 日付選択は ?plan ソフトナビ（本コンポーネントは再マウントしない）なので、一度開いた状態はそのまま保たれる。
  const [open, setOpen] = useState(selectedDate != null);

  // 直近にユーザーが選んだ日（自動スクロール待ち）。サーバ反映後に selectedDate がこの値になったら下の編集欄へ
  // スクロールする。これにより「ユーザーが選んだ時だけ」スクロールし、初回ロード（?plan 付き URL を直接開く）や
  // 月送り（selectedDate 不変）では飛ばさない。
  const pendingScrollRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedDate && pendingScrollRef.current === selectedDate) {
      pendingScrollRef.current = null;
      scrollToAnchor(SELECTED_DAY_ANCHOR_ID);
    }
  }, [selectedDate]);

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
  // 日付確定の単一経路（月グリッドのセルもチップ（明日/あさって）もここを通す）。今日は ?plan を出さず上へ戻す。
  function go(ymd: string) {
    if (ymd === today) {
      // 今日は上の「今日の編集」で入力中。?plan=today は下に何も出さない（page.tsx で plan=null）ので、空振りに
      // させず上の今日エディタへスクロールして戻す（要望 2026-06-23: 今日クリックの空振り解消）。
      scrollToAnchor(TODAY_ANCHOR_ID);
      return;
    }
    // scroll: false で App Router 既定の「ページ先頭へスクロール」を抑止し、サーバ反映後に下の「選択した日の編集」へ
    // 自分でスクロールする（pendingScrollRef → useEffect）。最上部（今日の編集）へは飛ばさない。
    pendingScrollRef.current = ymd;
    router.push(`/app/editor/${classId}?plan=${ymd}`, { scroll: false });
  }

  // チップ（明日 / あさって）は today から決定的に算出（ハイドレーション安全）。常に未来なので無効化対象にならない。
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);

  return (
    <section aria-label="別の日も準備する" className={styles.card}>
      {/* ヘッダー行: トグル（月グリッド開閉）＋クイックチップ。チップは畳んでいても押せるよう本体の外に常設する。 */}
      <div className={styles.headerRow}>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className={styles.toggleIcon} aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          別の日も準備する
          {!open && selectedDate ? (
            <span className={styles.toggleSelected}>（{formatShort(selectedDate)} を編集中）</span>
          ) : null}
        </button>
        <div className={styles.chips}>
          <button
            type="button"
            className={styles.chip}
            onClick={() => go(tomorrow)}
            aria-label={`明日（${formatShort(tomorrow)}）を編集`}
          >
            明日
          </button>
          <button
            type="button"
            className={styles.chip}
            onClick={() => go(dayAfter)}
            aria-label={`あさって（${formatShort(dayAfter)}）を編集`}
          >
            あさって
          </button>
        </div>
      </div>
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
      ) : null}
    </section>
  );
}
