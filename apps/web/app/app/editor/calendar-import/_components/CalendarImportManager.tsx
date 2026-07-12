"use client";

import type { FileImportedEventSummary } from "@/lib/editor/calendar-import-diff";
import { Button, ConfirmDialog, tokens } from "@kimiterrace/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CalendarImportClient } from "./CalendarImportClient";
import styles from "./calendar-import-modal.module.css";

const { color, fontSize, space } = tokens;

/**
 * 年間行事予定表ページの取込フロー開閉マネージャ（教員 FB 対応・#1274 follow-up）。
 * 管理画面の主役は「登録済みの行事一覧」で、ファイル取込は**必要なときに ＋ ボタンで開く操作**という
 * 位置づけ: タイトル行の右の「＋ ファイルから取り込む」で、取込フロー一式
 * （ファイル選択 → AI 読み取り → プレビュー → 保存モード選択 → 保存 = {@link CalendarImportClient}）を
 * **画面中央のフローティングモーダル**として開く（教員 FB「ページ下部への展開ではなく、ぽんっと
 * 浮いた感じで出てほしい」・#1259 follow-up。当初のインライン展開方式を置き換えた）。
 *
 * モーダルの器（見た目 / a11y）は ConfirmDialog（packages/ui）と同じ自前 fixed オーバーレイ方式:
 * - `role="dialog"` + `aria-modal` + `aria-labelledby`。開いたら**ダイアログ本体へフォーカス**
 *   （最初のコントロールに自動フォーカスしない = Enter 誤操作防止・ConfirmDialog と同判断）。
 *   閉じたら**＋ボタンへフォーカスを返す**（#1277 レビュー Low 指摘の解消）。
 * - Esc で閉じる（下記の破棄確認ゲートを通す）。ただし入れ子の ConfirmDialog
 *   （破棄確認 / 保存確認・`role="alertdialog"`・z-index 1000 で本モーダル 900/901 より手前）が
 *   開いている間はそちらの Esc（= キャンセル）に譲る（1 押下で 2 段閉じない）。
 * - **オーバーレイクリックでは閉じない**（ConfirmDialog と異なる意図的差分。プレビュー修正など
 *   長い作業を誤クリックで破棄確認に飛ばさない）。
 * - 開いている間は body スクロールをロック（背景一覧が独りでに流れない）。
 * - focus-trap は未対応（ConfirmDialog の follow-up 方針と同じ。利用が広がったら併せて追加する）。
 *
 * 開閉のセマンティクスは従来どおり:
 * - **読み取り中またはプレビュー（draft）がある間は、閉じる操作（× / Esc）に破棄確認を挟む**
 *   （誤操作で未保存の修正ごと読み取り結果を失わないため。閉じる = CalendarImportClient の
 *   unmount = 状態破棄）。
 * - 保存成功時は自動で閉じ、保存結果メッセージ（role="status"）を一覧の上に出す（一覧は client 側の
 *   router.refresh() で最新化済み）。プレビュー表が縦に長い問題はモーダル内部スクロール
 *   （max-height 90vh・モバイルはほぼ全画面）で吸収する。
 *
 * 一覧本体（server component）は children で受けて client 境界越しに挟む（サーバ描画のまま温存）。
 */
export function CalendarImportManager({
  existingFileEvents,
  existingFileName,
  children,
}: {
  /**
   * 今年度窓内の取込済み（`file:` 名前空間）行事（{@link CalendarImportClient} へ透過。
   * 置き換え保存の確認ダイアログの差分表示 = 削除される行事一覧の existing 側になる）。
   */
  existingFileEvents: FileImportedEventSummary[];
  /** 前回取込のファイル名（取込済みが無ければ null・{@link CalendarImportClient} へ透過）。 */
  existingFileName: string | null;
  /** サーバ描画の「登録済みの行事」一覧セクション。 */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // 取込フローに「閉じると失われる状態」（AI 読み取り中 / プレビュー表示中）があるか。子が通知する。
  const [dirty, setDirty] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // 保存成功メッセージ。自動で閉じた後も一覧の上に残して「保存された」ことを明示する。
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // ＋ボタンの DOM 参照（閉じた時のフォーカス返却先）。Button（packages/ui）は ref を props 型で
  // 受けないため、display: contents のラッパ経由で実 button を取る（packages/ui は本 PR の所有境界外）。
  const triggerWrapRef = useRef<HTMLSpanElement | null>(null);
  const titleId = useId();

  // open 遷移時に一度だけ本体へフォーカス（ConfirmDialog と同作法）。閉じたら＋ボタンへ返す
  // （#1277 レビュー Low 指摘）。初期描画（closed→closed）では何もしない。
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    } else if (prevOpenRef.current) {
      triggerWrapRef.current?.querySelector("button")?.focus();
    }
    prevOpenRef.current = open;
  }, [open]);

  // 開いている間は背景（body）スクロールをロック。閉じたら元の値へ戻す。
  useEffect(() => {
    if (!open) {
      return;
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Esc で閉じる（破棄確認ゲート付き）。入れ子の ConfirmDialog（破棄確認 / 保存確認 =
  // role="alertdialog"）が開いている間は、その Esc（キャンセル・ConfirmDialog 自身の listener）に
  // 譲って何もしない（DOM を見るのは、保存確認が子 CalendarImportClient 内にあり props では
  // 見えないため。alertdialog は React の state 反映前でも event 時点の DOM に必ず居る）。
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      if (document.querySelector('[role="alertdialog"]')) {
        return;
      }
      if (dirty) {
        setDiscardConfirmOpen(true);
        return;
      }
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dirty]);

  /** 閉じる要求（× / Esc）。破棄されうる状態がある間は確認を挟む（確認なしで消さない）。 */
  function requestClose() {
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setOpen(false);
  }

  function openModal() {
    setSavedMsg(null);
    setOpen(true);
  }

  return (
    <>
      <div style={headerRowStyle}>
        <header style={{ display: "grid", gap: space.xs }}>
          <h1 style={titleStyle}>年間行事予定表</h1>
          <p style={leadStyle}>
            学校の年間行事カレンダーを確認・取込できます。年間行事予定表ファイルを AI
            で読み取って登録でき、読み取り結果は保存前に必ず確認・修正できます。
          </p>
        </header>
        <span ref={triggerWrapRef} style={{ display: "contents" }}>
          <Button variant="primary" onClick={openModal} aria-haspopup="dialog" aria-expanded={open}>
            ＋ ファイルから取り込む
          </Button>
        </span>
      </div>

      {savedMsg ? (
        <p role="status" style={successStyle}>
          {savedMsg}
        </p>
      ) : null}

      {children}

      {open ? (
        <div className={styles.overlay} role="presentation">
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
          >
            <div className={styles.header}>
              <h2 id={titleId} className={styles.title}>
                ファイルから取り込む
              </h2>
              <button
                type="button"
                className={styles.close}
                onClick={requestClose}
                aria-label="閉じる"
              >
                ×
              </button>
            </div>
            <div className={styles.body}>
              <CalendarImportClient
                existingFileEvents={existingFileEvents}
                existingFileName={existingFileName}
                onDirtyChange={setDirty}
                onSaved={(message) => {
                  // 保存済み = 破棄されるものは無い。自動で閉じて一覧（router.refresh 済み）を見せる。
                  setSavedMsg(message);
                  setDirty(false);
                  setOpen(false);
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={discardConfirmOpen}
        title="読み取り結果を破棄しますか？"
        description="閉じると、AI の読み取り結果（プレビューでの修正を含む）は保存されずに破棄されます。"
        confirmLabel="破棄して閉じる"
        tone="danger"
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          setDirty(false);
          setOpen(false);
        }}
        onCancel={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: space.md,
  alignItems: "flex-start",
  justifyContent: "space-between",
};
const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.xl,
  fontWeight: 700,
  color: color.ink,
};
const leadStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.muted,
};
const successStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.successFg,
};
