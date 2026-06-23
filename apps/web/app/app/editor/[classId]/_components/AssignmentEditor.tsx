"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { padBlankRows } from "@/lib/editor/prefill-rows";
import type { AssignmentItem } from "@/lib/editor/notice-assignment-core";
import type { EditorTarget } from "@/lib/editor/schedule-core";
import { isValidDate, targetId } from "@/lib/editor/schedule-core";
import { useEffect, useState } from "react";
import { AutoSaveStatusText } from "./AutoSaveStatusText";
import {
  inputStyle,
  removeBtnStyle,
  saveBarStyle,
  secondaryBtnStyle,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
} from "./editor-styles";
import { toEditorTarget } from "./target";
import { useScopedDailyDataActions } from "./target-school";
import { useGridTabNavigation } from "./useGridTabNavigation";

/**
 * 提出物 (課題) エディタ (#48-I、段A-2 で scope 汎用化)。**Client Component** — 件の追加/削除/編集を
 * 行い、変更時に `setAssignmentsAction` を target (学校/学科/学年/クラス) 付きで**自動保存**する。検証・
 * 認可・監査・RLS は Server Action 側が担保するので、ここは入力収集と結果表示に徹する。
 *
 * `target` を渡すと任意 scope を編集できる。後方互換のため `classId` だけ渡されたらクラス編集になる。
 *
 * UIUX（保存ボタン廃止）: 追加・編集・削除した時点で自動保存（{@link useAutoSaveSection}）。提出物名が
 * 空・締切が不正な行があるうちは保存しない（入力が揃った時点で保存）。
 */
type Row = { deadline: string; subject: string; task: string };

/** 行 state を保存ペイロード（AssignmentItem[]）に正規化する。dirty 判定と保存で同じ写像を使う。 */
function toAssignmentItems(rows: Row[]): AssignmentItem[] {
  return rows.map((r) => ({ deadline: r.deadline, subject: r.subject, task: r.task }));
}

/**
 * 事前生成した「空行」か。締切は既定で対象日が入るので無視し、教員が入力する科目・提出物が**両方**空のとき空行。
 * 片方だけ入力（例: 科目だけ）の行は空行ではない＝従来どおり「未入力の項目があります」を出し、保存しない。
 */
function isBlankAssignmentRow(r: Row): boolean {
  return r.subject.trim() === "" && r.task.trim() === "";
}

export function AssignmentEditor({
  classId,
  target: targetProp,
  date,
  initialItems,
  onItemsChange,
  prefillRows = 0,
}: {
  classId?: string;
  target?: EditorTarget;
  date: string;
  initialItems: AssignmentItem[];
  /**
   * WYSIWYG ライブプレビュー連動（任意・追加 prop）。編集のたび現在の保存ペイロード相当（{@link toAssignmentItems}
   * 正規化後）を親へ通知する。**保存・検証・自動保存・RLS/監査の挙動には一切影響しない**（観測専用）。
   */
  onItemsChange?: (items: AssignmentItem[]) => void;
  /**
   * 盤面の規定枠ぶん**空行を事前生成**する数（{@link blockRowCapacity}）。既定 0（scope/ops 等は事前生成せず
   * 従来挙動）。空行（科目・提出物が両方空）は保存ペイロード・自動保存判定から除外され、保存をブロックしない。
   */
  prefillRows?: number;
}) {
  const target = toEditorTarget(targetProp, classId);
  // 対象校スコープ (system_admin の /ops 経路) を末尾引数に結ぶ。Provider 無し (=/app) なら従来動作 (回帰なし)。
  const { setAssignments } = useScopedDailyDataActions();
  const [rows, setRows] = useState<Row[]>(() =>
    padBlankRows(
      initialItems.map((i) => ({ deadline: i.deadline, subject: i.subject, task: i.task })),
      prefillRows,
      // 事前生成の空行は提出期限を対象日で初期化（addRow と同じ既定。そのまま使えることが多い）。
      () => ({ deadline: date, subject: "", task: "" }),
    ),
  );

  // 事前生成した空行（科目・提出物が両方空）は保存ペイロード・complete から除外する（空枠で保存をブロックせず、
  // 空の提出物を保存しない）。片方だけ入力した行は残り、従来どおり必須項目チェックの対象になる。
  const filledRows = rows.filter((r) => !isBlankAssignmentRow(r));
  const items = toAssignmentItems(filledRows);
  const serialized = serializeForDirty(items);
  // ライブプレビュー連動: 保存ペイロードが変わるたび親へ通知（観測専用・保存ロジックとは独立）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialized は items 変化のトリガ
  useEffect(() => {
    onItemsChange?.(items);
  }, [serialized, onItemsChange]);
  // 科目名・提出物名が空 / 締切が不正な行があるうちは保存しない（サーバ必須項目が揃った時点で自動保存）。
  const complete = filledRows.every(
    (r) => r.subject.trim().length > 0 && r.task.trim().length > 0 && isValidDate(r.deadline),
  );
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setAssignments(target.scope, targetId(target), date, toSave),
  });

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    // 既定の提出期限は編集中の対象日 (そのまま使えることが多い)。
    setRows((prev) => [...prev, { deadline: date, subject: "", task: "" }]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }
  // Tab 縦移動（スプレッドシート風・共有フック {@link useGridTabNavigation}）。col: 0=科目 / 1=提出物。
  // 提出期限は native date ピッカー（内部セグメント間 Tab を残す）なので登録せず既定動作のまま。
  const { registerCell, onCellKeyDown } = useGridTabNavigation(rows.length, addRow);

  return (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: "640px" }}>
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>提出期限</th>
              <th style={thStyle}>科目</th>
              <th style={thStyle}>提出物</th>
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // 行は順序が UI 状態なので index key で十分 (保存時に deadline でソート/検証)。
              // biome-ignore lint/suspicious/noArrayIndexKey: 可変フォーム行
              <tr key={i}>
                <td style={tdStyle}>
                  <input
                    type="date"
                    value={r.deadline}
                    onChange={(e) => update(i, { deadline: e.target.value })}
                    style={inputStyle}
                    aria-label={`${i + 1} 件目の提出期限`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    ref={(el) => registerCell(i, 0, el)}
                    value={r.subject}
                    onChange={(e) => update(i, { subject: e.target.value })}
                    onKeyDown={(e) => onCellKeyDown(e, i, 0)}
                    placeholder="科目名"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 件目の科目名`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    ref={(el) => registerCell(i, 1, el)}
                    value={r.task}
                    onChange={(e) => update(i, { task: e.target.value })}
                    onKeyDown={(e) => onCellKeyDown(e, i, 1)}
                    placeholder="提出物の内容"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 件目の提出物`}
                  />
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    style={removeBtnStyle}
                    aria-label={`${i + 1} 件目を削除`}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={saveBarStyle}>
        <button type="button" onClick={addRow} style={secondaryBtnStyle}>
          提出物を追加
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </div>
  );
}
