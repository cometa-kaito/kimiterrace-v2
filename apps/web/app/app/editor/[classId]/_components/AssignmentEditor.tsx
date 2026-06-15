"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { setAssignmentsAction } from "@/lib/editor/notice-assignment-actions";
import type { AssignmentItem } from "@/lib/editor/notice-assignment-core";
import type { EditorTarget } from "@/lib/editor/schedule-core";
import { isValidDate, targetId } from "@/lib/editor/schedule-core";
import { useState } from "react";
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

export function AssignmentEditor({
  classId,
  target: targetProp,
  date,
  initialItems,
}: {
  classId?: string;
  target?: EditorTarget;
  date: string;
  initialItems: AssignmentItem[];
}) {
  const target = toEditorTarget(targetProp, classId);
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i) => ({ deadline: i.deadline, subject: i.subject, task: i.task })),
  );

  const items = toAssignmentItems(rows);
  const serialized = serializeForDirty(items);
  // 科目名・提出物名が空 / 締切が不正な行があるうちは保存しない（サーバ必須項目が揃った時点で自動保存）。
  const complete = rows.every(
    (r) => r.subject.trim().length > 0 && r.task.trim().length > 0 && isValidDate(r.deadline),
  );
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setAssignmentsAction(target.scope, targetId(target), date, toSave),
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
                    value={r.subject}
                    onChange={(e) => update(i, { subject: e.target.value })}
                    placeholder="科目名"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 件目の科目名`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.task}
                    onChange={(e) => update(i, { task: e.target.value })}
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
