"use client";

import {
  EDITOR_SAVE_STATE_LABEL,
  deriveEditorSaveState,
  serializeForDirty,
  useUnsavedGuard,
} from "@/lib/editor/editor-save-state";
import { setAssignmentsAction } from "@/lib/editor/notice-assignment-actions";
import type { AssignmentItem } from "@/lib/editor/notice-assignment-core";
import type { EditorTarget } from "@/lib/editor/schedule-core";
import { targetId } from "@/lib/editor/schedule-core";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  dirtyTextStyle,
  inputStyle,
  primaryBtnDisabledStyle,
  primaryBtnStyle,
  removeBtnStyle,
  saveBarStyle,
  savedTextStyle,
  secondaryBtnStyle,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
} from "./editor-styles";
import { toEditorTarget } from "./target";

/**
 * 提出物 (課題) エディタ (#48-I、段A-2 で scope 汎用化)。**Client Component** — 件の追加/削除/編集を
 * 行い、保存時に `setAssignmentsAction` を target (学校/学科/学年/クラス) 付きで呼ぶ。検証・認可・監査・
 * RLS は Server Action 側が担保するので、ここは入力収集と結果表示に徹する (保存後は `router.refresh()`)。
 *
 * `target` を渡すと任意 scope を編集できる。後方互換のため `classId` だけ渡されたらクラス編集になる。
 *
 * #243 (②UI-UX): 未保存ガード・保存状態の明示・未変更時の保存無効化・入力 aria-label・狭幅での表横スクロール。
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
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i) => ({ deadline: i.deadline, subject: i.subject, task: i.task })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  const currentSerialized = serializeForDirty(toAssignmentItems(rows));
  const baselineRef = useRef<string>(currentSerialized);
  const dirty = currentSerialized !== baselineRef.current;
  const saveState = deriveEditorSaveState({ dirty, savedOnce });
  useUnsavedGuard(dirty);

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

  function save() {
    const items = toAssignmentItems(rows);
    startTransition(async () => {
      const res = await setAssignmentsAction(target.scope, targetId(target), date, items);
      if (res.ok) {
        baselineRef.current = serializeForDirty(items);
        setSavedOnce(true);
        setMsg({ ok: true, text: "保存しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: "640px" }}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

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
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          style={pending || !dirty ? primaryBtnDisabledStyle : primaryBtnStyle}
        >
          {pending ? "保存中..." : "保存"}
        </button>
        {saveState !== "idle" ? (
          <span style={saveState === "dirty" ? dirtyTextStyle : savedTextStyle} aria-live="polite">
            {saveState === "dirty" ? "● " : "✓ "}
            {EDITOR_SAVE_STATE_LABEL[saveState]}
          </span>
        ) : null}
      </div>
    </div>
  );
}
