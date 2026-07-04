"use client";

import type { NoticeItem, PinnedNoticeRow } from "@/lib/editor/notice-assignment-core";
import { tokens } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { type CSSProperties, useState } from "react";
import { removeBtnStyle } from "./editor-styles";
import { useScopedDailyDataActions } from "./target-school";

/**
 * 「固定中のお知らせ」一覧（F-C・設計書 editor-restructure-bulletin-2026-07.md §5.4）。**Client Component**。
 *
 * 固定行（`pinned: true`）は自然消滅せず、かつエディタの連絡初期値は「対象日の行」だけなので、入力日以外の
 * 日のエディタでは**見えない幽霊**になる（削除経路が生命線・受入基準 PR-C-2）。本コンポーネントは対象日に
 * 関わらず固定中の連絡（区切り線含む）を入力日つきで一覧し、**削除＝入力日の行の置換保存**（既存
 * `setNoticesAction` を入力日向けに呼ぶ・新 action 不要）を提供する。検証・認可・監査・RLS は Server Action
 * 側の既存担保をそのまま共有する。
 *
 * - **対象日（編集中の日付）に入力された固定行は出さない**: その行は上の NoticeEditor に「ずっと」選択の
 *   通常行として見えて編集・削除できるため、二重表示と置換保存の競合（一覧の削除 vs エディタの自動保存が
 *   同じ行を書く）を避ける。
 * - 削除成功後は `router.refresh()` でサーバデータを再取得する。エディタは `key={date}:{copied}` のまま
 *   なので入力中の内容は失われない（別日付の行への操作＝現在の編集と独立）。
 */
export function PinnedNoticesList({
  classId,
  currentDate,
  rows,
}: {
  classId: string;
  /** 編集中の対象日 (YYYY-MM-DD)。この日付の行は NoticeEditor 側に見えるため一覧から除く。 */
  currentDate: string;
  /** クラス直の固定行を含む行（入力日昇順・getClassPinnedNoticeRows の結果）。 */
  rows: PinnedNoticeRow[];
}) {
  const { setNotices } = useScopedDailyDataActions();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // 一覧に出すのは「対象日以外の行」の pinned 項目のみ（行内 index は削除＝置換保存に使う）。
  const entries = rows
    .filter((row) => row.date !== currentDate)
    .flatMap((row) =>
      row.items.map((item, index) => ({ row, item, index })).filter((e) => e.item.pinned === true),
    );
  if (entries.length === 0) {
    return null;
  }

  async function remove(row: PinnedNoticeRow, index: number) {
    const key = `${row.date}:${index}`;
    if (!window.confirm("この固定表示のお知らせを削除しますか？（サイネージから消えます）")) {
      return;
    }
    setPendingKey(key);
    setError(null);
    try {
      // 削除＝入力日の行から当該項目を除いた**置換保存**（§5.4。空になれば空配列＝行の全削除と同義）。
      const next = row.items.filter((_, i) => i !== index);
      const res = await setNotices("class", classId, row.date, next);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      router.refresh();
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <section aria-labelledby="pinned-notices-heading" style={boxStyle}>
      <h3 id="pinned-notices-heading" style={headingStyle}>
        固定中のお知らせ
      </h3>
      <p style={noteStyle}>
        「ずっと（固定表示）」の連絡は日付に関わらず表示され続けます。やめる時はここから削除してください。
      </p>
      <ul style={listStyle}>
        {entries.map(({ row, item, index }, i) => {
          const key = `${row.date}:${index}`;
          return (
            <li key={key} style={rowStyle}>
              <span style={dateStyle}>{jpShortDate(row.date)} から</span>
              <span style={textStyle}>{pinnedLabel(item)}</span>
              <button
                type="button"
                onClick={() => remove(row, index)}
                disabled={pendingKey !== null}
                style={removeBtnStyle}
                aria-label={`固定中のお知らせ ${i + 1} 件目を削除`}
              >
                {pendingKey === key ? "削除中…" : "削除"}
              </button>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** 一覧の表示ラベル。区切り線はラベル任意（空なら「区切り線」）を罫線つきで示す。 */
function pinnedLabel(item: NoticeItem): string {
  if (item.kind === "divider") {
    return `── ${item.text.length > 0 ? item.text : "区切り線"} ──`;
  }
  return item.text;
}

/** 入力日の短い和風ラベル（"7月1日"）。不正形はそのまま返す（fail-soft・表示のみ）。 */
function jpShortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) {
    return date;
  }
  return `${m}月${d}日`;
}

const boxStyle: CSSProperties = {
  marginTop: "0.9rem",
  paddingTop: "0.75rem",
  borderTop: `1px dashed ${tokens.color.border}`,
};
const headingStyle: CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.ink,
  margin: "0 0 0.25rem",
};
const noteStyle: CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  margin: "0 0 0.5rem",
};
const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.4rem",
};
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const dateStyle: CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  whiteSpace: "nowrap",
};
const textStyle: CSSProperties = {
  flex: 1,
  minWidth: "10rem",
  fontSize: "0.9rem",
  color: tokens.color.ink,
  overflowWrap: "anywhere",
};
const errorStyle: CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.dangerFg,
  margin: "0.4rem 0 0",
};
