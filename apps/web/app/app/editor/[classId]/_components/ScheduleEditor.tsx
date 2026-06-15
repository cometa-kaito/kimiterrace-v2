"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import type { EditorTarget, ScheduleItem } from "@/lib/editor/schedule-core";
import { editorBasePath, targetId } from "@/lib/editor/schedule-core";
import { useRouter } from "next/navigation";
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
 * 予定エディタ (#48-H、段A-2 で scope 汎用化)。**Client Component** — 行の追加/削除/編集を行い、
 * 変更時に `setScheduleAction` を target (学校/学科/学年/クラス) 付きで**自動保存**する。検証・認可・監査・
 * RLS は Server Action 側が担保するので、ここは入力収集と結果表示に徹する。
 *
 * `target` を渡すと任意 scope を編集できる。後方互換のため `classId` だけ渡されたらクラス編集になる。
 *
 * UIUX（保存ボタン廃止）: 明示的な「保存」操作を不要にし、追加・編集・削除した時点で自動保存する
 * （{@link useAutoSaveSection}）。未入力の行があるうちは保存しない（入力が揃った時点で保存）。対象日の
 * 切替時は debounce 取りこぼしを防ぐため確実に保存してから遷移する（flush）。
 */
type Row = {
  period: number;
  subject: string;
  note: string;
  location: string;
  targetAudience: string;
};

/** 行 state を保存ペイロード（ScheduleItem[]）に正規化する。dirty 判定と保存で同じ写像を使う。 */
function toScheduleItems(rows: Row[]): ScheduleItem[] {
  return rows.map((r) => ({
    period: r.period,
    subject: r.subject,
    ...(r.note.trim() ? { note: r.note } : {}),
    ...(r.location.trim() ? { location: r.location } : {}),
    ...(r.targetAudience.trim() ? { targetAudience: r.targetAudience } : {}),
  }));
}

export function ScheduleEditor({
  classId,
  target: targetProp,
  date,
  initialItems,
}: {
  classId?: string;
  target?: EditorTarget;
  date: string;
  initialItems: ScheduleItem[];
}) {
  const target = toEditorTarget(targetProp, classId);
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i) => ({
      period: i.period,
      subject: i.subject,
      note: i.note ?? "",
      location: i.location ?? "",
      targetAudience: i.targetAudience ?? "",
    })),
  );

  const items = toScheduleItems(rows);
  const serialized = serializeForDirty(items);
  // 全行が有効（科目あり・時限 1..12）かつ時限が重複しないなら自動保存。未入力/重複があるうちは保存しない
  // （サーバが弾く＝保存失敗の error 状態になるのを避け、揃った時点で保存）。
  const periods = rows.map((r) => r.period);
  const complete =
    rows.every(
      (r) =>
        r.subject.trim().length > 0 &&
        Number.isInteger(r.period) &&
        r.period >= 1 &&
        r.period <= 12,
    ) && new Set(periods).size === periods.length;
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setScheduleAction(target.scope, targetId(target), date, toSave),
  });

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    const nextPeriod = rows.length > 0 ? Math.max(...rows.map((r) => r.period)) + 1 : 1;
    setRows((prev) => [
      ...prev,
      { period: nextPeriod, subject: "", note: "", location: "", targetAudience: "" },
    ]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function changeDate(next: string) {
    // 未保存分があれば確実に保存してから対象日を切り替える（自動保存 debounce の取りこぼし防止）。
    if (auto.dirty) {
      await auto.flush();
    }
    router.push(`${editorBasePath(target)}?date=${next}`);
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

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>時限</th>
              <th style={thStyle}>科目</th>
              <th style={thStyle}>補足</th>
              <th style={thStyle}>場所</th>
              <th style={thStyle}>対象者</th>
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
                    aria-label={`${i + 1} 行目の時限`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.subject}
                    onChange={(e) => update(i, { subject: e.target.value })}
                    placeholder="科目名"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の科目名`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.note}
                    onChange={(e) => update(i, { note: e.target.value })}
                    placeholder="(任意)"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の補足`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.location}
                    onChange={(e) => update(i, { location: e.target.value })}
                    placeholder="(任意) 体育館 等"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の場所`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.targetAudience}
                    onChange={(e) => update(i, { targetAudience: e.target.value })}
                    placeholder="(任意) 3年生 等"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の対象者`}
                  />
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    style={removeBtnStyle}
                    aria-label={`${i + 1} 行目を削除`}
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
          コマを追加
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </div>
  );
}
