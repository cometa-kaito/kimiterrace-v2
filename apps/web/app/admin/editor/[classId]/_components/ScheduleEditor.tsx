"use client";

import {
  EDITOR_SAVE_STATE_LABEL,
  deriveEditorSaveState,
  serializeForDirty,
  useUnsavedGuard,
} from "@/lib/editor/editor-save-state";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import type { EditorTarget, ScheduleItem } from "@/lib/editor/schedule-core";
import { editorBasePath, targetId } from "@/lib/editor/schedule-core";
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
 * 予定エディタ (#48-H、段A-2 で scope 汎用化)。**Client Component** — 行の追加/削除/編集を行い、
 * 保存時に `setScheduleAction` を target (学校/学科/学年/クラス) 付きで呼ぶ。検証・認可・監査・RLS は
 * Server Action 側が担保するので、ここは入力収集と結果表示に徹する (保存後は `router.refresh()`)。
 *
 * `target` を渡すと任意 scope を編集できる。後方互換のため `classId` だけ渡されたらクラス編集になる。
 *
 * #243 (②UI-UX): 未保存ガード（離脱時のブラウザ確認 + 対象日切替時の confirm）・保存状態の明示
 * （未保存/保存済み）・未変更時の保存ボタン無効化・入力 aria-label・狭幅での表横スクロールを備える。
 */
type Row = { period: number; subject: string; note: string };

/** 行 state を保存ペイロード（ScheduleItem[]）に正規化する。dirty 判定と保存で同じ写像を使う。 */
function toScheduleItems(rows: Row[]): ScheduleItem[] {
  return rows.map((r) => ({
    period: r.period,
    subject: r.subject,
    ...(r.note.trim() ? { note: r.note } : {}),
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
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i) => ({ period: i.period, subject: i.subject, note: i.note ?? "" })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  // dirty は「保存される items」基準で判定する（行 state の cosmetic 差で誤検出しない）。
  const currentSerialized = serializeForDirty(toScheduleItems(rows));
  const baselineRef = useRef<string>(currentSerialized);
  const dirty = currentSerialized !== baselineRef.current;
  const saveState = deriveEditorSaveState({ dirty, savedOnce });
  useUnsavedGuard(dirty);

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
    // 未保存の変更があるまま対象日を切り替えると編集が破棄されるため確認する（データ消失防止）。
    if (dirty && !window.confirm("未保存の変更があります。破棄して対象日を切り替えますか？")) {
      return;
    }
    router.push(`${editorBasePath(target)}?date=${next}`);
  }

  function save() {
    const items = toScheduleItems(rows);
    startTransition(async () => {
      const res = await setScheduleAction(target.scope, targetId(target), date, items);
      if (res.ok) {
        // 保存成功で baseline を現在値に更新（dirty 解消）。
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

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
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
