"use client";

import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { PhotoImportZone } from "./PhotoImportZone";
import styles from "./PlanToolsMenu.module.css";
import { secondaryBtnStyle } from "./editor-styles";

const { color, fontSize, radius, space } = tokens;

/**
 * 「設定・取り込み」メニュー（2026-07-22 ユーザー要望「盤面直下が情報過多。上級者向け機能も
 * 混ざっているので、何かのボタンにまとめて触れるように」への回答）。
 *
 * 盤面直下（左 sticky カラム）の planActions には**毎日使う**「ほかの日からコピー」だけを残し、
 * 頻度の低い 3 操作をこの 1 つのポップオーバーへ畳む（頻度による段階的開示＝一等地を静かに保つ）:
 *
 * - **基本時間割を設定**（年 1 回の初期設定・週次テンプレがある学級だけ / 死リンク防止）
 * - **年間予定表を取り込む**（年 1 回・行事 0 件の学級にも初回導線を保証）
 * - **プリント/写真から取り込む**（AI 有効環境だけ・{@link PhotoImportZone}）
 *
 * ポップオーバー機構（トリガー ▾ / Escape・外側クリックで閉じる / 絶対配置パネル）は
 * {@link CopyFromMenu} と同じ視覚言語・作法に揃える（教員が覚える操作の型を 1 つにする）。表示条件
 * （時間割の有無・AI 有効）と各リンクの認可ゲートは親（page.tsx）が判定し、真のものだけ prop で渡す。
 */
export function PlanToolsMenu({
  classId,
  showTimetableLink,
  calendarImportPath,
  showPhotoImport,
}: {
  classId: string;
  /** 週次ベース時間割がある学級だけ「基本時間割を設定」を出す（死リンク防止・periodSchedule 有無）。 */
  showTimetableLink: boolean;
  /** 年間予定表取込ページのパス（親が単一ソースの定数 CALENDAR_IMPORT_PAGE_PATH を渡す）。 */
  calendarImportPath: string;
  /** AI 有効環境だけ写真取込導線を出す（isAiEnabled()・prod 既定は false）。 */
  showPhotoImport: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  // 開いている間だけ Escape / 外側クリックで閉じる（CopyFromMenu と同一作法）。開いた瞬間にパネルへ
  // フォーカスを移し、Escape ではトリガーへ戻す（キーボード操作の巡回を閉じる）。
  useEffect(() => {
    if (!open) {
      return;
    }
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={wrapStyle}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={secondaryBtnStyle}
      >
        設定・取り込み <span aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          style={panelStyle}
        >
          <p id={titleId} style={panelTitleStyle}>
            設定・取り込み
          </p>
          <p style={panelHintStyle}>はじめに一度だけ・たまに使う操作</p>

          {showTimetableLink ? (
            <Link
              href={`/app/editor/${classId}/timetable`}
              className={styles.item}
              onClick={() => setOpen(false)}
            >
              <span>基本時間割を設定</span>
              <span aria-hidden="true" className={styles.arrow}>
                →
              </span>
            </Link>
          ) : null}

          <Link href={calendarImportPath} className={styles.item} onClick={() => setOpen(false)}>
            <span>年間予定表を取り込む</span>
            <span aria-hidden="true" className={styles.arrow}>
              →
            </span>
          </Link>

          {showPhotoImport ? (
            <div className={styles.photoWrap}>
              <PhotoImportZone classId={classId} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
};
const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 0.4rem)",
  left: 0,
  zIndex: 40,
  width: "min(20rem, calc(100vw - 2rem))",
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.16)",
  padding: space.md,
  outline: "none",
};
const panelTitleStyle: React.CSSProperties = {
  margin: "0 0 0.15rem",
  fontSize: fontSize.sm,
  fontWeight: 700,
  color: color.ink,
};
const panelHintStyle: React.CSSProperties = {
  margin: `0 0 ${space.sm}`,
  fontSize: fontSize.xs,
  color: color.muted,
};
