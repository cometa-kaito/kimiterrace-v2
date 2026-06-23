"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { setCalloutsAction } from "@/lib/editor/callouts-actions";
import { validateCalloutItems } from "@/lib/editor/callouts-core";
import type { StudentCallout } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import { useRef, useState } from "react";
import { AutoSaveStatusText } from "./AutoSaveStatusText";
import { DragHandle } from "./DragHandle";
import { FieldLegend, RequiredMark } from "./FieldMarks";
import {
  draggingRowStyle,
  dropOverRowStyle,
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
import { moveItem, useRowReorder } from "./useRowReorder";

/**
 * 生徒呼び出しエディタ（パターン2「生徒呼び出し」）。**Client Component** — クラス×日付の呼び出しを行で
 * 追加/削除/編集し、編集の都度 **全置換で自動保存** する（{@link useAutoSaveSection}）。検証（氏名必須 /
 * HH:MM / 長さ）・認可・監査・RLS・cross-tenant 防止は Server Action 側が担保する（VisitorsEditor と同部品）。
 *
 * **保存モデルを自動保存に統一（finding #16）**: 予定/連絡/提出物と同じ {@link useAutoSaveSection} に寄せ、
 * 手動保存ボタンを廃止する（保存非対称による「保存し忘れ」事故の解消）。氏名が未入力の行があるうちは保存しない。
 *
 * **生徒実名（ADR-034）**: 氏名は教室サイネージにフルネーム表示される。出席番号でなく実名なのは呼び出しの
 * 取り違え防止。生徒以外の機微情報は入れない。教員向け注記には内部 ADR 番号を出さない（理由文のみ）。
 *
 * **時刻入力（finding #10）**: `type="time"` のネイティブ時刻ピッカーにし、手打ちの「HH:MM」形式ミスを防ぐ。
 *
 * **表示順の変更（要望 2026-06-23）**: 呼び出しは既定では盤面で時刻順に並ぶが、教員が任意の順に並べ替えたい
 * ケースがあるため、行を**ドラッグ&ドロップ**で並べ替えられるようにする（{@link useRowReorder}・連絡 / 来校者と
 * 同部品）。当初併設した「上へ・下へ」ボタンは要望により廃止しドラッグのみにした（2026-06-23）。※ HTML5 D&D は
 * タッチ端末では発火しないため、タブレット/スマホでの並べ替えは別途要検討（現状は PC マウス前提）。並べ替え後の
 * 配列順は既存の自動保存経路でそのまま保存され、サーバが各行の位置を `sort_order` に採番する（migration 0035）。
 * 読み取りは `sort_order` 昇順優先（同順位は時刻→氏名）。
 */
type Row = {
  /** 行の安定キー（並べ替えで React の同一性を保つための描画用 id。保存対象外）。 */
  id: string;
  scheduledTime: string;
  studentName: string;
  location: string;
  reason: string;
};

/** 保存ペイロード（行の安定キー `id` は描画用なので保存対象外）。 */
type CalloutPayload = Omit<Row, "id">;

/** 行 state を保存ペイロードに正規化する（`id` を除く）。dirty 判定と保存で同じ写像を使う。 */
function toItems(rows: Row[]): CalloutPayload[] {
  return rows.map((r) => ({
    scheduledTime: r.scheduledTime,
    studentName: r.studentName,
    location: r.location,
    reason: r.reason,
  }));
}

export function CalloutsEditor({
  classId,
  date,
  initialItems,
}: {
  classId: string;
  date: string;
  initialItems: StudentCallout[];
}) {
  const [rows, setRows] = useState<Row[]>(
    initialItems.map((i, idx) => ({
      id: `r${idx}`,
      scheduledTime: i.scheduledTime ?? "",
      studentName: i.studentName,
      location: i.location ?? "",
      reason: i.reason ?? "",
    })),
  );
  // 新規行の安定キー用カウンタ（初期行は r0.. を使うので length から続け、衝突しない）。NoticeEditor と同方式。
  const nextId = useRef(initialItems.length);

  const items = toItems(rows);
  const serialized = serializeForDirty(items);
  // 全行が有効（氏名必須・時刻は指定時のみ HH:MM）なら自動保存する。判定はサーバと同じ純関数
  // `validateCalloutItems` を再利用し、client/server で検証規則が drift しないようにする（ルール3 の精神）。
  const complete = validateCalloutItems(items).ok;
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setCalloutsAction(classId, date, toSave),
  });

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    const id = `r${nextId.current}`;
    nextId.current += 1;
    setRows((prev) => [
      ...prev,
      { id, scheduledTime: "", studentName: "", location: "", reason: "" },
    ]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }
  // 並べ替え: 行を from→to へ移す。並べ替え後の配列順がそのまま保存ペイロード順になり、既存の自動保存
  // （dirty 判定 = serialized 変化）が走って sort_order が採番・保存される（盤面の表示順が変わる）。
  function moveRow(from: number, to: number) {
    setRows((prev) => moveItem(prev, from, to));
  }
  const rowReorder = useRowReorder(rows.length, moveRow);

  return (
    <section style={{ display: "grid", gap: "0.75rem", maxWidth: "760px" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>生徒呼び出し</h2>
      <p style={{ margin: 0, fontSize: "0.8rem", color: tokens.color.muted }}>
        ※ 氏名は教室のサイネージに表示されます（呼び出しの取り違え防止のため実名表示）。
      </p>
      <FieldLegend />

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle} aria-label="並べ替え" />
              <th style={thStyle}>時刻</th>
              <th style={thStyle}>
                生徒氏名
                <RequiredMark />
              </th>
              <th style={thStyle}>呼び出し先</th>
              <th style={thStyle}>用件</th>
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ ...tdStyle, padding: 0 }}>
                  <div style={emptyPlaceholderStyle}>
                    まだ呼び出しがありません。「呼び出しを追加」から入力します。
                  </div>
                </td>
              </tr>
            ) : null}
            {rows.map((r, i) => {
              const reorder = rowReorder(i);
              return (
                // 安定キー `r.id` で並べ替え時も行の同一性を保つ（NoticeEditor / VisitorsEditor と同方式）。
                <tr
                  key={r.id}
                  {...reorder.rowProps}
                  style={{
                    ...(reorder.isDragging ? draggingRowStyle : {}),
                    ...(reorder.isOver ? dropOverRowStyle : {}),
                  }}
                >
                  <td style={tdStyle}>
                    {rows.length > 1 ? (
                      <DragHandle reorder={reorder} label={`${i + 1} 行目を並べ替え`} />
                    ) : null}
                  </td>
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
                      value={r.studentName}
                      onChange={(e) => update(i, { studentName: e.target.value })}
                      placeholder="生徒氏名"
                      style={{ ...inputStyle, width: "100%" }}
                      aria-label={`${i + 1} 行目の生徒氏名`}
                    />
                  </td>
                  <td style={tdStyle}>
                    <input
                      value={r.location}
                      onChange={(e) => update(i, { location: e.target.value })}
                      placeholder="(任意) 職員室 等"
                      style={{ ...inputStyle, width: "100%" }}
                      aria-label={`${i + 1} 行目の呼び出し先`}
                    />
                  </td>
                  <td style={tdStyle}>
                    <input
                      value={r.reason}
                      onChange={(e) => update(i, { reason: e.target.value })}
                      placeholder="(任意) 用件"
                      style={{ ...inputStyle, width: "100%" }}
                      aria-label={`${i + 1} 行目の用件`}
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
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={saveBarStyle}>
        <button type="button" onClick={addRow} style={secondaryBtnStyle}>
          呼び出しを追加
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </section>
  );
}
