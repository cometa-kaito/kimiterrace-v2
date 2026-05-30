"use client";

import { setClassAssignmentsAction } from "@/lib/editor/notice-assignment-actions";
import type { AssignmentItem } from "@/lib/editor/notice-assignment-core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  inputStyle,
  primaryBtnStyle,
  removeBtnStyle,
  secondaryBtnStyle,
  tdStyle,
  thStyle,
} from "./editor-styles";

/**
 * 提出物 (課題) エディタ (#48-I)。**Client Component** — 件の追加/削除/編集を行い、保存時に
 * `setClassAssignmentsAction` を呼ぶ。検証・認可・監査・RLS は Server Action 側が担保するので、
 * ここは入力収集と結果表示に徹する (ScheduleEditor.tsx と同型、保存後は `router.refresh()`)。
 */
type Row = { deadline: string; subject: string; task: string };

export function AssignmentEditor({
  classId,
  date,
  initialItems,
}: {
  classId: string;
  date: string;
  initialItems: AssignmentItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i) => ({ deadline: i.deadline, subject: i.subject, task: i.task })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
    const items: AssignmentItem[] = rows.map((r) => ({
      deadline: r.deadline,
      subject: r.subject,
      task: r.task,
    }));
    startTransition(async () => {
      const res = await setClassAssignmentsAction(classId, date, items);
      if (res.ok) {
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

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
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
                />
              </td>
              <td style={tdStyle}>
                <input
                  value={r.subject}
                  onChange={(e) => update(i, { subject: e.target.value })}
                  placeholder="科目名"
                  style={{ ...inputStyle, width: "100%" }}
                />
              </td>
              <td style={tdStyle}>
                <input
                  value={r.task}
                  onChange={(e) => update(i, { task: e.target.value })}
                  placeholder="提出物の内容"
                  style={{ ...inputStyle, width: "100%" }}
                />
              </td>
              <td style={tdStyle}>
                <button type="button" onClick={() => removeRow(i)} style={removeBtnStyle}>
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={addRow} style={secondaryBtnStyle}>
          提出物を追加
        </button>
        <button type="button" onClick={save} disabled={pending} style={primaryBtnStyle}>
          {pending ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
