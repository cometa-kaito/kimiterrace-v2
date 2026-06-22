"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import type { NoticeItem } from "@/lib/editor/notice-assignment-core";
import type { EditorTarget } from "@/lib/editor/schedule-core";
import { targetId } from "@/lib/editor/schedule-core";
import { useEffect, useRef, useState } from "react";
import { AutoSaveStatusText } from "./AutoSaveStatusText";
import {
  draggingRowStyle,
  dropOverRowStyle,
  gripStyle,
  inputStyle,
  moveBtnDisabledStyle,
  moveBtnStyle,
  removeBtnStyle,
  saveBarStyle,
  secondaryBtnStyle,
} from "./editor-styles";
import { toEditorTarget } from "./target";
import { useScopedDailyDataActions } from "./target-school";
import { type RowReorder, moveItem, useRowReorder } from "./useRowReorder";

/**
 * 連絡 (お知らせ) エディタ (#48-I、段A-2 で scope 汎用化)。**Client Component** — 件の追加/削除/編集を
 * 行い、変更時に `setNoticesAction` を target (学校/学科/学年/クラス) 付きで**自動保存**する。検証・認可・
 * 監査・RLS は Server Action 側が担保するので、ここは入力収集と結果表示に徹する。
 *
 * `target` を渡すと任意 scope を編集できる。後方互換のため `classId` だけ渡されたらクラス編集になる。
 *
 * #243 (②UI-UX): 各連絡に「表示日数」(入力日を起点に何日間サイネージに出すか) を持たせる。プリセット
 * (今日のみ/明日まで/3日間/1週間) + カスタム (1..14)。既定は今日のみ (1)。
 * UIUX（保存ボタン廃止）: 追加・編集・削除した時点で自動保存（{@link useAutoSaveSection}）。本文が空の
 * 行があるうちは保存しない（入力が揃った時点で保存）。
 *
 * D 群（並べ替え）: 連絡は **配列順 = サイネージ表示順**（`validateNoticeItems` が入力順を保持し、盤面も
 * 同じ配列順で描画する）ため、行をドラッグ&ドロップ / 「上へ・下へ」で並べ替えると、その順序が既存の
 * 自動保存経路でそのまま保存・反映される（migration 不要・盤面の表示物は増減しない＝順序だけ変わる）。
 * アクセシビリティ: マウスは grip の D&D、キーボード/タッチは「上へ・下へ」ボタン（色だけに依存しない）。
 * 時刻/時限でサーバ再ソートされる予定・提出物・来校者・呼び出しは本機構の対象外（盤面順を変えないため）。
 */
type Row = {
  id: string;
  text: string;
  isHighlight: boolean;
  displayDays: number;
  custom: boolean;
};

/** 表示日数のプリセット (入力日を起点に N 日間)。これ以外は「カスタム」で 1..14 を直接指定。 */
const DISPLAY_DAYS_PRESETS = [
  { value: 1, label: "今日のみ" },
  { value: 2, label: "明日まで" },
  { value: 3, label: "3日間" },
  { value: 7, label: "1週間" },
] as const;
const PRESET_VALUES = new Set<number>(DISPLAY_DAYS_PRESETS.map((p) => p.value));
const DISPLAY_DAYS_MAX = 14;

function clampDisplayDays(n: number): number {
  if (!Number.isFinite(n)) {
    return 1;
  }
  return Math.min(DISPLAY_DAYS_MAX, Math.max(1, Math.round(n)));
}

/** 行 state を保存ペイロード（NoticeItem[]）に正規化する。dirty 判定と保存で同じ写像を使う。 */
function toNoticeItems(rows: Row[]): NoticeItem[] {
  return rows.map((r) => ({
    text: r.text,
    ...(r.isHighlight ? { isHighlight: true } : {}),
    // 既定 1 (今日のみ) は省略して保存 (JSONB 最小化・後方互換)。
    ...(r.displayDays > 1 ? { displayDays: r.displayDays } : {}),
  }));
}

/**
 * 1 行ぶんの並べ替えコントロール（grip + 上へ/下へ）。マウスは grip を掴んでドラッグ、キーボード/タッチは
 * 「上へ」「下へ」ボタン（aria-label 付き・色だけに依存しない）。`position`/`total` で読み上げ位置を伝える。
 */
function ReorderControls({
  reorder,
  position,
  total,
}: {
  reorder: RowReorder;
  position: number;
  total: number;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.15rem" }}>
      <span
        {...reorder.handleProps}
        aria-hidden
        title="ドラッグして並べ替え（または 上へ/下へ ボタン）"
        style={gripStyle}
      >
        ⠿
      </span>
      <button
        type="button"
        onClick={() => reorder.onMove(-1)}
        disabled={!reorder.canUp}
        style={reorder.canUp ? moveBtnStyle : moveBtnDisabledStyle}
        aria-label={`${position} 件目を上へ移動（全 ${total} 件中）`}
      >
        <span aria-hidden>↑</span>
      </button>
      <button
        type="button"
        onClick={() => reorder.onMove(1)}
        disabled={!reorder.canDown}
        style={reorder.canDown ? moveBtnStyle : moveBtnDisabledStyle}
        aria-label={`${position} 件目を下へ移動（全 ${total} 件中）`}
      >
        <span aria-hidden>↓</span>
      </button>
    </span>
  );
}

export function NoticeEditor({
  classId,
  target: targetProp,
  date,
  initialItems,
  onItemsChange,
}: {
  classId?: string;
  target?: EditorTarget;
  date: string;
  initialItems: NoticeItem[];
  /**
   * WYSIWYG ライブプレビュー連動（任意・追加 prop）。編集のたび現在の保存ペイロード相当（{@link toNoticeItems}
   * 正規化後）を親へ通知する。**保存・検証・自動保存・RLS/監査の挙動には一切影響しない**（観測専用）。
   */
  onItemsChange?: (items: NoticeItem[]) => void;
}) {
  const target = toEditorTarget(targetProp, classId);
  // 対象校スコープ (system_admin の /ops 経路) を末尾引数に結ぶ。Provider 無し (=/app) なら従来動作 (回帰なし)。
  const { setNotices } = useScopedDailyDataActions();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i, idx) => {
      const dd = i.displayDays ?? 1;
      return {
        id: `r${idx}`,
        text: i.text,
        isHighlight: i.isHighlight ?? false,
        displayDays: dd,
        custom: !PRESET_VALUES.has(dd),
      };
    }),
  );
  // 新規行の安定キー用カウンタ。初期行は r0.. を使うので length から続け、衝突しない。
  const nextId = useRef(initialItems.length);

  const items = toNoticeItems(rows);
  const serialized = serializeForDirty(items);
  // ライブプレビュー連動: 保存ペイロードが変わるたび親へ通知（観測専用・保存ロジックとは独立）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialized は items 変化のトリガ
  useEffect(() => {
    onItemsChange?.(items);
  }, [serialized, onItemsChange]);
  // 本文が空の行があるうちは保存しない（入力が揃った時点で自動保存）。
  const complete = rows.every((r) => r.text.trim().length > 0);
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setNotices(target.scope, targetId(target), date, toSave),
  });

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    const id = `r${nextId.current}`;
    nextId.current += 1;
    setRows((prev) => [
      ...prev,
      { id, text: "", isHighlight: false, displayDays: 1, custom: false },
    ]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }
  // 並べ替え（D 群）: 行を from→to へ移す。並べ替え後の配列順がそのまま保存ペイロード順になり、
  // 既存の自動保存（dirty 判定 = serialized 変化）が走って保存・盤面反映される（順序のみ変更）。
  function moveRow(from: number, to: number) {
    setRows((prev) => moveItem(prev, from, to));
  }
  const rowReorder = useRowReorder(rows.length, moveRow);

  return (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: "720px" }}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
        {rows.map((r, i) => {
          const reorder = rowReorder(i);
          return (
            <li
              key={r.id}
              {...reorder.dropProps}
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
                flexWrap: "wrap",
                ...(reorder.isDragging ? draggingRowStyle : {}),
                ...(reorder.isOver ? dropOverRowStyle : {}),
              }}
            >
              {rows.length > 1 ? (
                <ReorderControls reorder={reorder} position={i + 1} total={rows.length} />
              ) : null}
              <input
                value={r.text}
                onChange={(e) => update(i, { text: e.target.value })}
                placeholder="連絡事項"
                style={{ ...inputStyle, flex: 1, minWidth: "12rem" }}
                aria-label={`${i + 1} 件目の連絡事項`}
              />
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.25rem",
                  fontSize: "0.85rem",
                }}
              >
                <input
                  type="checkbox"
                  checked={r.isHighlight}
                  onChange={(e) => update(i, { isHighlight: e.target.checked })}
                />
                重要
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.25rem",
                  fontSize: "0.85rem",
                }}
              >
                表示
                <select
                  value={r.custom ? "custom" : String(r.displayDays)}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "custom") {
                      update(i, { custom: true });
                    } else {
                      update(i, { custom: false, displayDays: Number(v) });
                    }
                  }}
                  style={inputStyle}
                  aria-label={`${i + 1} 件目の表示日数`}
                >
                  {DISPLAY_DAYS_PRESETS.map((p) => (
                    <option key={p.value} value={String(p.value)}>
                      {p.label}
                    </option>
                  ))}
                  <option value="custom">カスタム</option>
                </select>
              </label>
              {r.custom ? (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.25rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <input
                    type="number"
                    min={1}
                    max={DISPLAY_DAYS_MAX}
                    value={r.displayDays}
                    onChange={(e) =>
                      update(i, { displayDays: clampDisplayDays(Number(e.target.value)) })
                    }
                    style={{ ...inputStyle, width: "4rem" }}
                    aria-label={`${i + 1} 件目の表示日数 (日)`}
                  />
                  日間
                </label>
              ) : null}
              <button
                type="button"
                onClick={() => removeRow(i)}
                style={removeBtnStyle}
                aria-label={`${i + 1} 件目を削除`}
              >
                削除
              </button>
            </li>
          );
        })}
      </ul>

      <div style={saveBarStyle}>
        <button type="button" onClick={addRow} style={secondaryBtnStyle}>
          連絡を追加
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </div>
  );
}
