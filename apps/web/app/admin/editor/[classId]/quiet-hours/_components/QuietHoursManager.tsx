"use client";

import { saveQuietHoursAction } from "@/lib/school-admin/quiet-hours-actions";
import type { QuietRange } from "@/lib/school-admin/quiet-hours-core";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * クラス静粛時間の設定 UI (#48-J-2)。**Client Component** — 時間帯リストをローカル state で編集し、
 * 保存時に**配列全体**を `saveQuietHoursAction` (upsert) に渡す。成功時は `router.refresh()` で
 * Server Component を再取得する。認可・検証 (HH:MM / start<end / 重なり)・監査・cross-tenant 検証は
 * Server Action 側 (quiet-hours-actions.ts) と RLS が担保するので、ここは入力収集と結果表示に徹する。
 *
 * 時間帯 0 件で保存すると「静粛時間なし」に更新できる (全削除)。
 */
export function QuietHoursManager({
  classId,
  initialRanges,
}: {
  classId: string;
  initialRanges: QuietRange[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ranges, setRanges] = useState<QuietRange[]>(initialRanges);

  function updateRange(i: number, patch: Partial<QuietRange>) {
    setRanges((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRange() {
    setRanges((prev) => [...prev, { start: "", end: "" }]);
  }
  function removeRange(i: number) {
    setRanges((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 空欄 ("") はそのまま渡し、Server Action 側の検証 (HH:MM) で弾く (部分保存しない)。
    startTransition(async () => {
      const res = await saveQuietHoursAction(classId, ranges);
      if (res.ok) {
        setMsg({ ok: true, text: "静粛時間を保存しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "1rem", maxWidth: "560px" }}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <section style={cardStyle}>
        <h2 style={h2Style}>静粛時間帯 ({ranges.length})</h2>
        {ranges.length === 0 ? (
          <p style={{ color: "#6b7280", margin: "0 0 0.75rem" }}>
            設定された時間帯はありません。サイネージは終日表示されます。
          </p>
        ) : (
          <ul style={listStyle}>
            {ranges.map((r, i) => (
              // 行は順序を持ち編集中に再採番されないため index key で十分。
              // biome-ignore lint/suspicious/noArrayIndexKey: 編集対象の固定行
              <li key={i} style={rowStyle}>
                <label style={labelStyle}>
                  開始
                  <input
                    type="time"
                    value={r.start}
                    onChange={(e) => updateRange(i, { start: e.target.value })}
                    style={inputStyle}
                    disabled={pending}
                    aria-label={`時間帯 ${i + 1} 開始時刻`}
                  />
                </label>
                <span aria-hidden="true">〜</span>
                <label style={labelStyle}>
                  終了
                  <input
                    type="time"
                    value={r.end}
                    onChange={(e) => updateRange(i, { end: e.target.value })}
                    style={inputStyle}
                    disabled={pending}
                    aria-label={`時間帯 ${i + 1} 終了時刻`}
                  />
                </label>
                <button
                  type="button"
                  disabled={pending}
                  style={dangerBtnStyle}
                  onClick={() => removeRange(i)}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" disabled={pending} style={ghostBtnStyle} onClick={addRange}>
          時間帯を追加
        </button>
      </section>

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="submit" disabled={pending} style={btnStyle}>
          保存
        </button>
      </div>
    </form>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "1rem",
};
const h2Style: React.CSSProperties = { fontSize: "1.1rem", margin: "0 0 0.5rem" };
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "0 0 0.75rem",
  padding: 0,
  display: "grid",
  gap: "0.5rem",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: "0.5rem",
  flexWrap: "wrap",
};
const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  fontSize: "0.85rem",
  color: "#374151",
};
const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
};
const btnStyle: React.CSSProperties = {
  padding: "0.4rem 0.9rem",
  background: "#1f2937",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};
const ghostBtnStyle: React.CSSProperties = {
  padding: "0.4rem 0.8rem",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  cursor: "pointer",
};
const dangerBtnStyle: React.CSSProperties = {
  ...ghostBtnStyle,
  color: "#b91c1c",
  borderColor: "#fecaca",
};
