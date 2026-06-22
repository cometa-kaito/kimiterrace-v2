"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { setVisitorsAction } from "@/lib/editor/visitors-actions";
import { validateVisitorItems } from "@/lib/editor/visitors-core";
import type { ClassVisitor } from "@kimiterrace/db";
import { useRef, useState } from "react";
import { AutoSaveStatusText } from "./AutoSaveStatusText";
import { FieldLegend, RequiredMark } from "./FieldMarks";
import {
  draggingRowStyle,
  dropOverRowStyle,
  emptyPlaceholderStyle,
  gripStyle,
  inputStyle,
  moveBtnDisabledStyle,
  moveBtnStyle,
  removeBtnStyle,
  saveBarStyle,
  secondaryBtnStyle,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
} from "./editor-styles";
import { type RowReorder, moveItem, useRowReorder } from "./useRowReorder";

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
 *
 * **表示順の変更（要望 2026-06-22）**: 来校者は既定では盤面で時刻順に並ぶが、教員が任意の順に並べ替えたい
 * ケースがあるため、行をドラッグ&ドロップ /「上へ・下へ」で並べ替えられるようにする（{@link useRowReorder}・
 * 連絡 D 群と同部品）。並べ替え後の配列順は既存の自動保存経路でそのまま保存され、サーバが各行の位置を
 * `sort_order` に採番する（migration 0034）。読み取りは `sort_order` 昇順優先（同順位は時刻→氏名）。
 */
type Row = {
  /** 行の安定キー（並べ替えで React の同一性を保つための描画用 id。保存対象外）。 */
  id: string;
  scheduledTime: string;
  visitorName: string;
  affiliation: string;
  purpose: string;
  host: string;
  note: string;
};

/** 保存ペイロード（行の安定キー `id` は描画用なので保存対象外）。 */
type VisitorPayload = Omit<Row, "id">;

/** 行 state を保存ペイロードに正規化する（`id` を除く）。dirty 判定と保存で同じ写像を使う。 */
function toItems(rows: Row[]): VisitorPayload[] {
  return rows.map((r) => ({
    scheduledTime: r.scheduledTime,
    visitorName: r.visitorName,
    affiliation: r.affiliation,
    purpose: r.purpose,
    host: r.host,
    note: r.note,
  }));
}

/**
 * 1 行ぶんの並べ替えコントロール（grip + 上へ/下へ）。マウスは grip を掴んでドラッグ、キーボード/タッチは
 * 「上へ」「下へ」ボタン（aria-label 付き・色だけに依存しない）。連絡エディタ（NoticeEditor）の同名部品と
 * 同じ視覚言語・操作で揃える。
 */
function ReorderControls({
  reorder,
  position,
  total,
}: {
  reorder: RowReorder;
  position: number;
  total: number;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.15rem" }}>
      <span
        {...reorder.handleProps}
        aria-hidden
        title="ドラッグして並べ替え（または 上へ/下へ ボタン）"
        style={gripStyle}
      >
        ⠿
      </span>
      <button
        type="button"
        onClick={() => reorder.onMove(-1)}
        disabled={!reorder.canUp}
        style={reorder.canUp ? moveBtnStyle : moveBtnDisabledStyle}
        aria-label={`${position} 行目を上へ移動（全 ${total} 行中）`}
      >
        <span aria-hidden>↑</span>
      </button>
      <button
        type="button"
        onClick={() => reorder.onMove(1)}
        disabled={!reorder.canDown}
        style={reorder.canDown ? moveBtnStyle : moveBtnDisabledStyle}
        aria-label={`${position} 行目を下へ移動（全 ${total} 行中）`}
      >
        <span aria-hidden>↓</span>
      </button>
    </span>
  );
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
    initialItems.map((i, idx) => ({
      id: `r${idx}`,
      scheduledTime: i.scheduledTime ?? "",
      visitorName: i.visitorName,
      affiliation: i.affiliation ?? "",
      purpose: i.purpose ?? "",
      host: i.host ?? "",
      note: i.note ?? "",
    })),
  );
  // 新規行の安定キー用カウンタ（初期行は r0.. を使うので length から続け、衝突しない）。NoticeEditor と同方式。
  const nextId = useRef(initialItems.length);

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
    const id = `r${nextId.current}`;
    nextId.current += 1;
    setRows((prev) => [
      ...prev,
      { id, scheduledTime: "", visitorName: "", affiliation: "", purpose: "", host: "", note: "" },
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
    <section style={{ display: "grid", gap: "0.75rem", maxWidth: "880px", marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0 }}>来校者一覧</h2>
      <FieldLegend />

      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle} aria-label="並べ替え" />
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
                <td colSpan={8} style={{ ...tdStyle, padding: 0 }}>
                  <div style={emptyPlaceholderStyle}>
                    まだ来校者がありません。「来校者を追加」から入力します。
                  </div>
                </td>
              </tr>
            ) : null}
            {rows.map((r, i) => {
              const reorder = rowReorder(i);
              return (
                // 安定キー `r.id` で並べ替え時も行の同一性を保つ（NoticeEditor と同方式）。
                <tr
                  key={r.id}
                  {...reorder.dropProps}
                  style={{
                    ...(reorder.isDragging ? draggingRowStyle : {}),
                    ...(reorder.isOver ? dropOverRowStyle : {}),
                  }}
                >
                  <td style={tdStyle}>
                    {rows.length > 1 ? (
                      <ReorderControls reorder={reorder} position={i + 1} total={rows.length} />
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
              );
            })}
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
