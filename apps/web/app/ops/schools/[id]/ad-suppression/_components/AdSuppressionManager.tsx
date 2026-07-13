"use client";

import { saveAdSuppressionAction } from "@/lib/school-admin/ad-suppression-actions";
import {
  type AdSuppressionRange,
  type AdSuppressionVariation,
  NONE_VARIATION_KEY,
} from "@/lib/signage/ad-suppression";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

/**
 * 授業時間中の広告停止 設定 UI（システム管理者・`/ops/schools/{id}/ad-suppression`）。**Client Component**。
 *
 * 3 段構成をローカル state で編集し、保存時に**全体**を `saveAdSuppressionAction`（upsert）へ渡す:
 *  1. **時間割バリエーション**（通常/短縮…）＝名前 ＋ 広告を止める時間帯のリスト。
 *  2. **曜日ごとの既定**＝各曜日にバリエーション or「広告を止めない」or「設定なし」を割り当て。
 *  3. **特定日の上書き**＝日付ごとに割り当て（曜日既定より優先）。
 *
 * 認可・検証（HH:MM / start<end / 重なり / key 参照整合 / 日付妥当）・監査・display_settings 相乗りキー保全は
 * Server Action 側と RLS が担保するので、ここは入力収集と結果表示に徹する。成功時は `router.refresh()`。
 */

/** 曜日の表示ラベル（index = 0:日 .. 6:土。schema と単一ソース）。 */
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
/** 表示順は月〜土→日（学校運用で平日を先頭に）。値（0..6）は schema のまま。 */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** 「設定なし」を表す select の内部値（weekdayMap/overrides から当該キーを外す）。 */
const UNSET = "";

type OverrideRow = { date: string; key: string };

export function AdSuppressionManager({
  schoolId,
  initialEnabled,
  initialVariations,
  initialWeekdayMap,
  initialOverrides,
}: {
  schoolId: string;
  initialEnabled: boolean;
  initialVariations: AdSuppressionVariation[];
  initialWeekdayMap: Record<number, string>;
  initialOverrides: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [variations, setVariations] = useState<AdSuppressionVariation[]>(initialVariations);
  const [weekdayMap, setWeekdayMap] = useState<Record<number, string>>(initialWeekdayMap);
  const [overrides, setOverrides] = useState<OverrideRow[]>(() =>
    Object.entries(initialOverrides)
      .map(([date, key]) => ({ date, key }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  );

  /* --- バリエーション操作 --- */
  function addVariation() {
    setVariations((prev) => [
      ...prev,
      { key: crypto.randomUUID(), name: "", ranges: [{ start: "", end: "" }] },
    ]);
  }
  function removeVariation(key: string) {
    setVariations((prev) => prev.filter((v) => v.key !== key));
    // 参照していた割り当ては「設定なし」に落とす（幽霊参照を残さない）。
    setWeekdayMap((prev) => {
      const next: Record<number, string> = {};
      for (const [d, k] of Object.entries(prev)) {
        if (k !== key) {
          next[Number(d)] = k;
        }
      }
      return next;
    });
    setOverrides((prev) => prev.filter((o) => o.key !== key));
  }
  function updateVariation(key: string, patch: Partial<AdSuppressionVariation>) {
    setVariations((prev) => prev.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  }
  function updateRange(vKey: string, i: number, patch: Partial<AdSuppressionRange>) {
    setVariations((prev) =>
      prev.map((v) =>
        v.key === vKey
          ? { ...v, ranges: v.ranges.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }
          : v,
      ),
    );
  }
  function addRange(vKey: string) {
    setVariations((prev) =>
      prev.map((v) =>
        v.key === vKey ? { ...v, ranges: [...v.ranges, { start: "", end: "" }] } : v,
      ),
    );
  }
  function removeRange(vKey: string, i: number) {
    setVariations((prev) =>
      prev.map((v) =>
        v.key === vKey ? { ...v, ranges: v.ranges.filter((_, idx) => idx !== i) } : v,
      ),
    );
  }

  /* --- 割り当て操作 --- */
  function setWeekday(day: number, value: string) {
    setWeekdayMap((prev) => {
      const next = { ...prev };
      if (value === UNSET) {
        delete next[day];
      } else {
        next[day] = value;
      }
      return next;
    });
  }
  function addOverride() {
    setOverrides((prev) => [...prev, { date: "", key: NONE_VARIATION_KEY }]);
  }
  function updateOverride(i: number, patch: Partial<OverrideRow>) {
    setOverrides((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  }
  function removeOverride(i: number) {
    setOverrides((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // overrides のリストを {date: key} へ畳む（後の行が勝つ）。空 date 行は落とす。
    const overrideObj: Record<string, string> = {};
    for (const o of overrides) {
      if (o.date) {
        overrideObj[o.date] = o.key;
      }
    }
    startTransition(async () => {
      const res = await saveAdSuppressionAction(
        schoolId,
        enabled,
        variations,
        weekdayMap,
        overrideObj,
      );
      if (res.ok) {
        setMsg({ ok: true, text: "授業時間（広告停止）を保存しました。" });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  // 割り当て select の共通オプション（バリエーション ＋ 止めない ＋ 任意で設定なし）。
  const assignmentOptions = (includeUnset: boolean) => (
    <>
      {includeUnset ? <option value={UNSET}>（設定なし・広告あり）</option> : null}
      {variations.map((v) => (
        <option key={v.key} value={v.key}>
          {v.name.trim() || "（名称未設定）"}
        </option>
      ))}
      <option value={NONE_VARIATION_KEY}>広告を止めない</option>
    </>
  );

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "1rem", maxWidth: "640px" }}>
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
            <span style={mutedSmall}>
              オフのときは、下の設定に関わらず広告は停止しません（全モニタで終日広告あり）。
            </span>
          </span>
        </label>
      </section>

      {/* ① 時間割バリエーション */}
      <section style={cardStyle}>
        <h2 style={h2Style}>① 時間割バリエーション（{variations.length}）</h2>
        <p style={mutedSmall}>
          通常時間割・短縮時間割などを登録します。各時間帯（授業のコマ）に広告を止めます。
        </p>
        {variations.length === 0 ? (
          <p style={{ color: "#6b7280", margin: "0.5rem 0" }}>
            まだ時間割がありません。「時間割を追加」から作成してください。
          </p>
        ) : (
          <div style={{ display: "grid", gap: "0.75rem", margin: "0.5rem 0" }}>
            {variations.map((v) => (
              <div key={v.key} style={variationBoxStyle}>
                <div style={variationHeadStyle}>
                  <input
                    type="text"
                    value={v.name}
                    placeholder="時間割の名前（例：通常時間割）"
                    onChange={(e) => updateVariation(v.key, { name: e.target.value })}
                    disabled={pending}
                    style={nameInputStyle}
                    aria-label="時間割の名前"
                  />
                  <button
                    type="button"
                    disabled={pending}
                    style={dangerBtnStyle}
                    onClick={() => removeVariation(v.key)}
                  >
                    時間割を削除
                  </button>
                </div>
                <ul style={listStyle}>
                  {v.ranges.map((r, i) => (
                    // 行は順序を持ち編集中に再採番されないため index key で十分。
                    // biome-ignore lint/suspicious/noArrayIndexKey: 編集対象の固定行
                    <li key={i} style={rowStyle}>
                      <label style={labelStyle}>
                        開始
                        <input
                          type="time"
                          value={r.start}
                          onChange={(e) => updateRange(v.key, i, { start: e.target.value })}
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
                          onChange={(e) => updateRange(v.key, i, { end: e.target.value })}
                          style={inputStyle}
                          disabled={pending}
                          aria-label={`時間帯 ${i + 1} 終了時刻`}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={pending}
                        style={dangerBtnStyle}
                        onClick={() => removeRange(v.key, i)}
                      >
                        削除
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={pending}
                  style={ghostBtnStyle}
                  onClick={() => addRange(v.key)}
                >
                  時間帯を追加
                </button>
              </div>
            ))}
          </div>
        )}
        <button type="button" disabled={pending} style={ghostBtnStyle} onClick={addVariation}>
          時間割を追加
        </button>
      </section>

      {/* ② 曜日ごとの既定 */}
      <section style={cardStyle}>
        <h2 style={h2Style}>② 曜日ごとの既定</h2>
        <p style={mutedSmall}>
          各曜日にどの時間割を適用するかを選びます。「（設定なし・広告あり）」は終日広告、「広告を止めない」は
          明示的に止めない曜日です。
        </p>
        <div style={{ display: "grid", gap: "0.4rem", margin: "0.5rem 0 0" }}>
          {WEEKDAY_ORDER.map((day) => (
            <label key={day} style={weekdayRowStyle}>
              <span style={weekdayLabelStyle}>{WEEKDAY_LABELS[day]}曜日</span>
              <select
                value={weekdayMap[day] ?? UNSET}
                onChange={(e) => setWeekday(day, e.target.value)}
                disabled={pending}
                style={selectStyle}
              >
                {assignmentOptions(true)}
              </select>
            </label>
          ))}
        </div>
      </section>

      {/* ③ 特定日の上書き */}
      <section style={cardStyle}>
        <h2 style={h2Style}>③ 特定日の上書き（{overrides.length}）</h2>
        <p style={mutedSmall}>
          行事前日だけ短縮、考査日は広告を止めない、など特定の日付だけ曜日既定を上書きします。
        </p>
        {overrides.length === 0 ? (
          <p style={{ color: "#6b7280", margin: "0.5rem 0" }}>特定日の指定はありません。</p>
        ) : (
          <ul style={listStyle}>
            {overrides.map((o, i) => (
              // 行は date で識別しうるが未入力行が重複しうるため index key。
              // biome-ignore lint/suspicious/noArrayIndexKey: 編集対象の固定行
              <li key={i} style={rowStyle}>
                <input
                  type="date"
                  value={o.date}
                  onChange={(e) => updateOverride(i, { date: e.target.value })}
                  disabled={pending}
                  style={inputStyle}
                  aria-label={`特定日 ${i + 1} の日付`}
                />
                <select
                  value={o.key}
                  onChange={(e) => updateOverride(i, { key: e.target.value })}
                  disabled={pending}
                  style={selectStyle}
                  aria-label={`特定日 ${i + 1} の割り当て`}
                >
                  {assignmentOptions(false)}
                </select>
                <button
                  type="button"
                  disabled={pending}
                  style={dangerBtnStyle}
                  onClick={() => removeOverride(i)}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" disabled={pending} style={ghostBtnStyle} onClick={addOverride}>
          特定日を追加
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

const mutedSmall: React.CSSProperties = { color: "#6b7280", fontSize: "0.82rem", margin: 0 };
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
const h2Style: React.CSSProperties = { fontSize: "1.05rem", margin: "0 0 0.35rem" };
const variationBoxStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "0.75rem",
  background: "#fafafa",
};
const variationHeadStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  marginBottom: "0.5rem",
  flexWrap: "wrap",
};
const nameInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: "12rem",
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontWeight: 600,
};
const weekdayRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};
const weekdayLabelStyle: React.CSSProperties = {
  width: "4rem",
  fontSize: "0.9rem",
  color: "#374151",
};
const selectStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  background: "#fff",
  minWidth: "12rem",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "0 0 0.5rem",
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
