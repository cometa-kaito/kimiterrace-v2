"use client";

import type { FileImportedEventSummary } from "@/lib/editor/calendar-import-diff";
import { Button, ConfirmDialog, tokens } from "@kimiterrace/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CalendarImportClient } from "./CalendarImportClient";

const { color, fontSize, space } = tokens;

/**
 * 年間行事予定表ページの取込フロー開閉マネージャ（教員 FB 対応・#1274 follow-up）。
 * 管理画面の主役は「登録済みの行事一覧」で、ファイル取込は**必要なときに ＋ ボタンで開く操作**という
 * 位置づけに変える: タイトル行の右に「＋ ファイルから取り込む」を置き、取込セクション
 * （ファイル選択 → AI 読み取り → プレビュー → 置き換え保存 = {@link CalendarImportClient}）は初期非表示。
 *
 * - 展開時は取込セクションへスクロールする（jsdom 等 `scrollIntoView` 未実装環境は存在ガードで no-op）。
 * - **読み取り中またはプレビュー（draft）がある間は、畳む操作に破棄確認を挟む**（誤クリックで未保存の
 *   修正ごと読み取り結果を失わないため。畳む = 取込セクションの unmount = 状態破棄）。
 * - 保存成功時は自動で畳み、保存結果メッセージを一覧の上に出す（一覧は client 側の router.refresh() で
 *   最新化済み）。モーダル化はプレビュー表が縦に長いため不適で、展開セクション方式を採る。
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
  // 取込フローに「畳むと失われる状態」（AI 読み取り中 / プレビュー表示中）があるか。子が通知する。
  const [dirty, setDirty] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // 保存成功メッセージ。自動で畳んだ後も一覧の上に残して「保存された」ことを明示する。
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const flowRef = useRef<HTMLElement | null>(null);

  // 展開したら取込セクションを視界に入れる（＋ボタンと開いた先が離れていても迷わない）。
  useEffect(() => {
    if (open) {
      flowRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }
  }, [open]);

  /** 畳む要求。破棄されうる状態がある間は確認を挟む（確認なしで消さない）。 */
  function requestClose() {
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setOpen(false);
  }

  function toggle() {
    if (open) {
      requestClose();
      return;
    }
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
        <Button
          variant={open ? "secondary" : "primary"}
          onClick={toggle}
          aria-expanded={open}
          aria-controls={open ? IMPORT_FLOW_SECTION_ID : undefined}
        >
          {open ? "取込を閉じる" : "＋ ファイルから取り込む"}
        </Button>
      </div>

      {savedMsg ? (
        <p role="status" style={successStyle}>
          {savedMsg}
        </p>
      ) : null}

      {children}

      {open ? (
        <section
          ref={flowRef}
          id={IMPORT_FLOW_SECTION_ID}
          style={{ display: "grid", gap: space.sm }}
          aria-labelledby="calendar-import-flow-heading"
        >
          <div style={flowHeadingRowStyle}>
            <h2 id="calendar-import-flow-heading" style={importHeadingStyle}>
              ファイルから取り込む
            </h2>
            <Button variant="ghost" onClick={requestClose}>
              閉じる
            </Button>
          </div>
          <CalendarImportClient
            existingFileEvents={existingFileEvents}
            existingFileName={existingFileName}
            onDirtyChange={setDirty}
            onSaved={(message) => {
              // 保存済み = 破棄されるものは無い。自動で畳んで一覧（router.refresh 済み）を見せる。
              setSavedMsg(message);
              setDirty(false);
              setOpen(false);
            }}
          />
        </section>
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

/** 取込セクションの id（＋ボタンの aria-controls / 展開時スクロールの対象）。 */
const IMPORT_FLOW_SECTION_ID = "calendar-import-flow";

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: space.md,
  alignItems: "flex-start",
  justifyContent: "space-between",
};
const flowHeadingRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: space.md,
  alignItems: "center",
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
const importHeadingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.lg,
  fontWeight: 700,
  color: color.ink,
};
const successStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.successFg,
};
