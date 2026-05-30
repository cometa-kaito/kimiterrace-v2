"use client";

import { setClassScheduleAction } from "@/lib/editor/schedule-actions";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * 時間割エディタ (#48-H)。**Client Component** — 行の追加/削除/編集を行い、保存時に
 * `setClassScheduleAction` を呼ぶ。検証・認可・監査・RLS は Server Action 側が担保するので、
 * ここは入力収集と結果表示に徹する (保存後は `router.refresh()` で再取得)。
 */
type Row = { period: number; subject: string; note: string };

export function ScheduleEditor({
  classId,
  date,
  initialItems,
}: {
  classId: string;
  date: string;
  initialItems: ScheduleItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i) => ({ period: i.period, subject: i.subject, note: i.note ?? "" })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    const nextPeriod = rows.length > 0 ? Math.max(...rows.map((r) => r.period)) + 1 : 1;
    setRows((prev) => [...prev, { period: nextPeriod, subject: "", note: "" }]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function changeDate(next: string) {
    router.push(`/admin/editor/${classId}?date=${next}`);
  }

  function save() {
    const items: ScheduleItem[] = rows.map((r) => ({
      period: r.period,
      subject: r.subject,
      ...(r.note.trim() ? { note: r.note } : {}),
    }));
    startTransition(async () => {
      const res = await setClassScheduleAction(classId, date, items);
      if (res.ok) {
        setMsg({ ok: true, text: "保存しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <div style={{ display: "grid", gap: "1rem", maxWidth: "640px" }}>
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        対象日
        <input
          type="date"
          value={date}
          onChange={(e) => changeDate(e.target.value)}
          style={inputStyle}
        />
      </label>

      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={thStyle}>時限</th>
            <th style={thStyle}>科目</th>
            <th style={thStyle}>補足</th>
            <th style={thStyle} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // 行は順序が UI 状態なので index key で十分 (保存時に period でソート/検証)。
            // biome-ignore lint/suspicious/noArrayIndexKey: 可変フォーム行
            <tr key={i}>
              <td style={tdStyle}>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={r.period}
                  onChange={(e) => update(i, { period: Number(e.target.value) })}
                  style={{ ...inputStyle, width: "4rem" }}
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
                  value={r.note}
                  onChange={(e) => update(i, { note: e.target.value })}
                  placeholder="(任意)"
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
          コマを追加
        </button>
        <button type="button" onClick={save} disabled={pending} style={primaryBtnStyle}>
          {pending ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.85rem",
  color: "#6b7280",
  padding: "0.25rem 0.4rem",
};
const tdStyle: React.CSSProperties = { padding: "0.25rem 0.4rem", verticalAlign: "top" };
const primaryBtnStyle: React.CSSProperties = {
  padding: "0.45rem 1.1rem",
  background: "#1f2937",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};
const secondaryBtnStyle: React.CSSProperties = {
  padding: "0.45rem 1.1rem",
  background: "#fff",
  color: "#1f2937",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  cursor: "pointer",
};
const removeBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.6rem",
  background: "transparent",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.85rem",
};
