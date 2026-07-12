"use client";

import { saveAdSuppressionAction } from "@/lib/school-admin/ad-suppression-actions";
import type { AdSuppressionRange } from "@/lib/signage/ad-suppression";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * 授業時間中の広告停止 設定 UI（システム管理者・`/ops/schools/{id}/ad-suppression`）。**Client Component**。
 *
 * 有効トグル・対象曜日・時間帯リストをローカル state で編集し、保存時に**全体**を `saveAdSuppressionAction`
 * （upsert）へ渡す。成功時は `router.refresh()` で Server Component を再取得する。認可・検証（HH:MM /
 * start<end / 重なり / 曜日 0..6）・監査・cross-tenant 検証・display_settings 相乗りキー保全は Server Action
 * 側と RLS が担保するので、ここは入力収集と結果表示に徹する。
 *
 * 停止時間帯はサイネージ盤面の**広告枠だけ**を空にし、時間割・連絡・提出物など他ブロックは通常どおり出る。
 * 実機端末はポーリングで追従するため、授業終了で広告は自動的に戻る。
 */

/** 曜日の表示ラベル（index = 0:日 .. 6:土）。判定・保存は number（`isSuppressedAtMinutes`）と単一ソース。 */
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function AdSuppressionManager({
  schoolId,
  initialEnabled,
  initialRanges,
  initialWeekdays,
}: {
  /** 対象校 id（system_admin が対象校を結ぶ /ops 経路）。Server Action の先頭引数に渡す。 */
  schoolId: string;
  initialEnabled: boolean;
  initialRanges: AdSuppressionRange[];
  initialWeekdays: number[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set(initialWeekdays));
  const [ranges, setRanges] = useState<AdSuppressionRange[]>(initialRanges);

  function toggleWeekday(d: number) {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(d)) {
        next.delete(d);
      } else {
        next.add(d);
      }
      return next;
    });
  }
  function updateRange(i: number, patch: Partial<AdSuppressionRange>) {
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
    // 空欄 ("") はそのまま渡し、Server Action 側の検証（HH:MM）で弾く（部分保存しない）。
    const weekdayList = [...weekdays].sort((a, b) => a - b);
    startTransition(async () => {
      const res = await saveAdSuppressionAction(schoolId, enabled, ranges, weekdayList);
      if (res.ok) {
        setMsg({ ok: true, text: "授業時間（広告停止）を保存しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "1rem", maxWidth: "600px" }}>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <section style={cardStyle}>
        <label style={toggleRowStyle}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={pending}
          />
          <span>
            <strong>授業時間中は広告を停止する</strong>
            <br />
            <span style={{ color: "#6b7280", fontSize: "0.82rem" }}>
              オフのときは、下の時間帯を設定していても広告は停止しません。
            </span>
          </span>
        </label>
      </section>

      <section style={cardStyle}>
        <h2 style={h2Style}>対象曜日</h2>
        <p style={{ color: "#6b7280", margin: "0 0 0.5rem", fontSize: "0.82rem" }}>
          チェックした曜日だけ、下の時間帯に広告を停止します（既定は月〜金）。
        </p>
        <div style={weekdayRowStyle}>
          {WEEKDAY_LABELS.map((label, d) => (
            <label key={label} style={weekdayChipStyle(weekdays.has(d))}>
              <input
                type="checkbox"
                checked={weekdays.has(d)}
                onChange={() => toggleWeekday(d)}
                disabled={pending}
                style={{ marginRight: "0.3rem" }}
                aria-label={`${label}曜日`}
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section style={cardStyle}>
        <h2 style={h2Style}>授業時間帯（{ranges.length}）</h2>
        {ranges.length === 0 ? (
          <p style={{ color: "#6b7280", margin: "0 0 0.75rem" }}>
            設定された時間帯はありません。広告は終日表示されます。
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
const toggleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.6rem",
  cursor: "pointer",
  lineHeight: 1.5,
};
const h2Style: React.CSSProperties = { fontSize: "1.1rem", margin: "0 0 0.5rem" };
const weekdayRowStyle: React.CSSProperties = { display: "flex", gap: "0.4rem", flexWrap: "wrap" };
const weekdayChipStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  padding: "0.35rem 0.6rem",
  borderRadius: "6px",
  border: `1px solid ${active ? "#93c5fd" : "#d1d5db"}`,
  background: active ? "#eff6ff" : "#fff",
  color: active ? "#1e3a8a" : "#374151",
  fontSize: "0.9rem",
  cursor: "pointer",
});
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
