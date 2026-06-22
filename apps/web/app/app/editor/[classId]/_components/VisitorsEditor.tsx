"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { setVisitorsAction } from "@/lib/editor/visitors-actions";
import { validateVisitorItems } from "@/lib/editor/visitors-core";
import type { ClassVisitor } from "@kimiterrace/db";
import { useState } from "react";
import { AutoSaveStatusText } from "./AutoSaveStatusText";
import { FieldLegend, RequiredMark } from "./FieldMarks";
import {
  emptyPlaceholderStyle,
  inputStyle,
  removeBtnStyle,
  saveBarStyle,
  secondaryBtnStyle,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
} from "./editor-styles";

/**
 * 来校者一覧エディタ（パターン2「来校者一覧」）。**Client Component** — クラス×日付の来校者を行で
 * 追加/削除/編集し、編集の都度 **全置換で自動保存** する（{@link useAutoSaveSection}）。検証（氏名必須 /
 * HH:MM / 長さ）・認可・監査・RLS・cross-tenant 防止は Server Action 側が担保するので、ここは入力収集と
 * 保存状態の表示に徹する。
 *
 * **保存モデルを自動保存に統一（finding #16）**: 旧実装は明示「保存」ボタンの手動保存だったため、自動保存の
 * 予定/連絡/提出物と挙動が非対称で「保存したつもりで消える」事故源だった。予定/連絡/提出物と同じ
 * {@link useAutoSaveSection} に寄せて全エディタの保存 UX を一致させる。氏名が未入力の行があるうちは保存しない
 * （揃った時点で自動保存）。氏名は教室サイネージに表示される（生徒個人 PII を入れない・来校者は外部の成人。
 * class-visitors の「個人情報について」参照）。
 *
 * **時刻入力（finding #10）**: `type="time"` のネイティブ時刻ピッカーにし、手打ちの「HH:MM」形式ミスを防ぐ。
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

  const items = toItems(rows);
  const serialized = serializeForDirty(items);
  // 全行が有効（氏名必須・時刻は指定時のみ HH:MM）なら自動保存する。判定はサーバと同じ純関数
  // `validateVisitorItems` を再利用し、client/server で検証規則が drift しないようにする（ルール3 の精神）。
  const complete = validateVisitorItems(items).ok;
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setVisitorsAction(classId, date, toSave),
  });

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

  return (
    <section style={{ display: "grid", gap: "0.75rem", maxWidth: "880px", marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>来校者一覧</h2>
      <FieldLegend />

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>時刻</th>
              <th style={thStyle}>
                氏名
                <RequiredMark />
              </th>
              <th style={thStyle}>所属</th>
              <th style={thStyle}>用件</th>
              <th style={thStyle}>対応者</th>
              <th style={thStyle}>備考</th>
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ ...tdStyle, padding: 0 }}>
                  <div style={emptyPlaceholderStyle}>
                    まだ来校者がありません。「来校者を追加」から入力します。
                  </div>
                </td>
              </tr>
            ) : null}
            {rows.map((r, i) => (
              // 行は順序が UI 状態なので index key で十分（保存は全置換）。
              // biome-ignore lint/suspicious/noArrayIndexKey: 可変フォーム行
              <tr key={i}>
                <td style={tdStyle}>
                  <input
                    type="time"
                    value={r.scheduledTime}
                    onChange={(e) => update(i, { scheduledTime: e.target.value })}
                    style={{ ...inputStyle, width: "8rem" }}
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
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </section>
  );
}
