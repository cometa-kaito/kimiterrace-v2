"use client";

import { setClassNoticesAction } from "@/lib/editor/notice-assignment-actions";
import type { NoticeItem } from "@/lib/editor/notice-assignment-core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { inputStyle, primaryBtnStyle, removeBtnStyle, secondaryBtnStyle } from "./editor-styles";

/**
 * 連絡 (お知らせ) エディタ (#48-I)。**Client Component** — 件の追加/削除/編集を行い、保存時に
 * `setClassNoticesAction` を呼ぶ。検証・認可・監査・RLS は Server Action 側が担保するので、
 * ここは入力収集と結果表示に徹する (ScheduleEditor.tsx と同型、保存後は `router.refresh()`)。
 */
type Row = { text: string; isHighlight: boolean };

export function NoticeEditor({
  classId,
  date,
  initialItems,
}: {
  classId: string;
  date: string;
  initialItems: NoticeItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i) => ({ text: i.text, isHighlight: i.isHighlight ?? false })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { text: "", isHighlight: false }]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function save() {
    const items: NoticeItem[] = rows.map((r) => ({
      text: r.text,
      ...(r.isHighlight ? { isHighlight: true } : {}),
    }));
    startTransition(async () => {
      const res = await setClassNoticesAction(classId, date, items);
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

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
        {rows.map((r, i) => (
          // 行は順序が UI 状態なので index key で十分 (連絡は入力順を保持して保存)。
          // biome-ignore lint/suspicious/noArrayIndexKey: 可変フォーム行
          <li key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              value={r.text}
              onChange={(e) => update(i, { text: e.target.value })}
              placeholder="連絡事項"
              style={{ ...inputStyle, flex: 1 }}
            />
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.85rem" }}
            >
              <input
                type="checkbox"
                checked={r.isHighlight}
                onChange={(e) => update(i, { isHighlight: e.target.checked })}
              />
              重要
            </label>
            <button type="button" onClick={() => removeRow(i)} style={removeBtnStyle}>
              削除
            </button>
          </li>
        ))}
      </ul>

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={addRow} style={secondaryBtnStyle}>
          連絡を追加
        </button>
        <button type="button" onClick={save} disabled={pending} style={primaryBtnStyle}>
          {pending ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
