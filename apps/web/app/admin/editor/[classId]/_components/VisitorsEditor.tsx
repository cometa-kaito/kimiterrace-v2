"use client";

import {
  EDITOR_SAVE_STATE_LABEL,
  deriveEditorSaveState,
  serializeForDirty,
  useUnsavedGuard,
} from "@/lib/editor/editor-save-state";
import { setVisitorsAction } from "@/lib/editor/visitors-actions";
import type { ClassVisitor } from "@kimiterrace/db";
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

/**
 * 来校者一覧エディタ（パターン2「来校者一覧」）。**Client Component** — クラス×日付の来校者を行で
 * 追加/削除/編集し、保存時に **全置換** で `setVisitorsAction` を呼ぶ。検証（氏名必須 / HH:MM / 長さ）・
 * 認可・監査・RLS・cross-tenant 防止は Server Action 側が担保するので、ここは入力収集と結果表示に徹する。
 *
 * 未保存ガード・保存状態の明示・未変更時の保存無効化・aria-label・狭幅の表横スクロールは ScheduleEditor と
 * 同じ部品（editor-save-state / editor-styles）を共有する。氏名は教室サイネージに表示される（生徒個人 PII を
 * 入れない・来校者は外部の成人。class-visitors の「個人情報について」参照）。
 */
type Row = {
  scheduledTime: string;
  visitorName: string;
  affiliation: string;
  purpose: string;
  host: string;
  note: string;
};

/** 行 state を保存ペイロードに正規化する。dirty 判定と保存で同じ写像を使う。 */
function toItems(rows: Row[]): Row[] {
  return rows.map((r) => ({ ...r }));
}

export function VisitorsEditor({
  classId,
  date,
  initialItems,
}: {
  classId: string;
  date: string;
  initialItems: ClassVisitor[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i) => ({
      scheduledTime: i.scheduledTime ?? "",
      visitorName: i.visitorName,
      affiliation: i.affiliation ?? "",
      purpose: i.purpose ?? "",
      host: i.host ?? "",
      note: i.note ?? "",
    })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  const currentSerialized = serializeForDirty(toItems(rows));
  const baselineRef = useRef<string>(currentSerialized);
  const dirty = currentSerialized !== baselineRef.current;
  const saveState = deriveEditorSaveState({ dirty, savedOnce });
  useUnsavedGuard(dirty);

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [
      ...prev,
      { scheduledTime: "", visitorName: "", affiliation: "", purpose: "", host: "", note: "" },
    ]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function save() {
    const items = toItems(rows);
    startTransition(async () => {
      const res = await setVisitorsAction(classId, date, items);
      if (res.ok) {
        baselineRef.current = serializeForDirty(items);
        setSavedOnce(true);
        setMsg({ ok: true, text: `保存しました（${res.data.count} 名）。` });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error.message });
      }
    });
  }

  return (
    <section style={{ display: "grid", gap: "0.75rem", maxWidth: "880px", marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>来校者一覧</h2>
      {msg ? (
        <output style={{ display: "block", color: msg.ok ? "#166534" : "#b91c1c" }}>
          {msg.text}
        </output>
      ) : null}

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>時刻</th>
              <th style={thStyle}>氏名</th>
              <th style={thStyle}>所属</th>
              <th style={thStyle}>用件</th>
              <th style={thStyle}>対応者</th>
              <th style={thStyle}>備考</th>
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // 行は順序が UI 状態なので index key で十分（保存は全置換）。
              // biome-ignore lint/suspicious/noArrayIndexKey: 可変フォーム行
              <tr key={i}>
                <td style={tdStyle}>
                  <input
                    value={r.scheduledTime}
                    onChange={(e) => update(i, { scheduledTime: e.target.value })}
                    placeholder="HH:MM"
                    style={{ ...inputStyle, width: "5rem" }}
                    aria-label={`${i + 1} 行目の時刻`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.visitorName}
                    onChange={(e) => update(i, { visitorName: e.target.value })}
                    placeholder="氏名"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の氏名`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.affiliation}
                    onChange={(e) => update(i, { affiliation: e.target.value })}
                    placeholder="(任意) 所属"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の所属`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.purpose}
                    onChange={(e) => update(i, { purpose: e.target.value })}
                    placeholder="(任意) 用件"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の用件`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.host}
                    onChange={(e) => update(i, { host: e.target.value })}
                    placeholder="(任意) 対応者"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の対応者`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    value={r.note}
                    onChange={(e) => update(i, { note: e.target.value })}
                    placeholder="(任意) 備考"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の備考`}
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
          来校者を追加
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
    </section>
  );
}
