"use client";

import { useCallback, useState } from "react";
import { detailDotStyle, detailFieldStyle, detailToggleStyle, srOnlyStyle } from "./editor-styles";

/**
 * 各エディタ行の「詳細（任意項目）」開閉を司る共有プリミティブ（引き算レーン）。
 *
 * ## 方針: 主役だけ常時表示、任意項目は行ごとに畳む（progressive disclosure）
 * 予定（補足/場所/対象者）・来校者（所属/用件/対応者/備考）・呼び出し（呼び出し先/用件）・連絡（重要/表示日数）は
 * いずれも **必須は 1〜2 項目**で残りは任意。任意項目を常時広げると列幅が潰れ、スマホで入力が苦痛になる
 * （特に来校者は必須＝氏名のみで 6 列を常時展開していた）。そこで主役だけを残し、任意項目を行ごとの「詳細」に畳む。
 *
 * ## 絶対則: 既に値が入っている任意項目を隠さない
 * 初期表示で値の入っている行は最初から開く（{@link useRowDisclosure} の `initialOpenIds`）。これを守らないと、
 * 過去に入力済みの所属/場所等が畳まれて「消えた」と誤認される（WYSIWYG＝盤面一致の信頼が壊れる）。畳んだ後も、
 * 折りたたみ中に値があれば {@link RowDetailToggle} がドット＋SR 文言で「入力あり」を示す（色だけに依存しない・NFR05）。
 *
 * 開閉は **UI 状態のみ**。保存ペイロード・自動保存・検証・RLS/監査には一切関与しない（値は state に保持され、
 * 折りたたんでも保存対象から外れない）。
 */

/**
 * 行ごとの開閉状態（行の安定キー `id` の集合）。`initialOpenIds` は初期に開いておく行（＝任意項目に値がある行）。
 * 初期化は一度きり（useState 初期化子）なので、後から追加した空行は閉じたまま・削除した行の id は無害に残る。
 */
export function useRowDisclosure(initialOpenIds: string[]) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialOpenIds));
  const isOpen = useCallback((id: string) => open.has(id), [open]);
  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  return { isOpen, toggle };
}

/**
 * 行の「詳細」開閉トグル（素のテキストボタン・控えめ）。`open` で表裏を、`hasValue` で折りたたみ中の「入力あり」
 * ドットを出す。`controlsId` は開く詳細パネルの id（aria-controls）。`label` は SR 向けの操作名（例: 「2 行目の詳細項目」）。
 */
export function RowDetailToggle({
  open,
  hasValue,
  onToggle,
  controlsId,
  label,
}: {
  open: boolean;
  hasValue: boolean;
  onToggle: () => void;
  controlsId: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controlsId}
      aria-label={label}
      style={detailToggleStyle}
    >
      <span aria-hidden="true">詳細 {open ? "▴" : "▾"}</span>
      {!open && hasValue ? (
        <>
          <span aria-hidden="true" style={detailDotStyle} />
          <span style={srOnlyStyle}>（入力あり）</span>
        </>
      ) : null}
    </button>
  );
}

/**
 * 詳細パネル内の 1 項目（ラベルを上に小さく置き、その下に入力欄を縦に積む）。視覚キャプションは `<span>` で置き、
 * アクセシブル名は各入力が持つ `aria-label`（例「1 行目の補足」）が担う（`<label>` 関連付けの二重化を避ける）。
 */
export function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={detailFieldStyle}>
      <span>{label}</span>
      {children}
    </div>
  );
}
