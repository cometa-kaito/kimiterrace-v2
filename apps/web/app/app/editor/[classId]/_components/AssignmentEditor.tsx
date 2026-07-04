"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { padBlankRows } from "@/lib/editor/prefill-rows";
import type { AssignmentItem } from "@/lib/editor/notice-assignment-core";
import type { EditorTarget } from "@/lib/editor/schedule-core";
import { isValidDate, targetId } from "@/lib/editor/schedule-core";
import { Fragment, useEffect, useRef, useState } from "react";
import { AutoSaveStatusText } from "./AutoSaveStatusText";
import { DragHandle } from "./DragHandle";
import {
  detailPanelStyle,
  draggingRowStyle,
  dropOverRowStyle,
  inputStyle,
  removeBtnStyle,
  saveBarStyle,
  secondaryBtnStyle,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
} from "./editor-styles";
import { RowDetailToggle, useRowDisclosure } from "./RowDetails";
import { toEditorTarget } from "./target";
import { useScopedDailyDataActions } from "./target-school";
import { useGridTabNavigation } from "./useGridTabNavigation";
import { moveItem, resortFilledRows, useRowReorder } from "./useRowReorder";

/**
 * 提出物 (課題) エディタ (#48-I、段A-2 で scope 汎用化)。**Client Component** — 件の追加/削除/編集を
 * 行い、変更時に `setAssignmentsAction` を target (学校/学科/学年/クラス) 付きで**自動保存**する。検証・
 * 認可・監査・RLS は Server Action 側が担保するので、ここは入力収集と結果表示に徹する。
 *
 * `target` を渡すと任意 scope を編集できる。後方互換のため `classId` だけ渡されたらクラス編集になる。
 *
 * UIUX（保存ボタン廃止）: 追加・編集・削除した時点で自動保存（{@link useAutoSaveSection}）。提出物名が
 * 空・締切が不正な行があるうちは保存しない（入力が揃った時点で保存）。
 *
 * PR-B（自由度基本セット）: ⠿ D&D 並べ替え（§5.1・**同一期限内**＝validate の期限昇順は安定ソートなので
 * 配列順が同一期限内の表示順になる。別期限へ跨いだドロップはスナップバック）と ★重要（§5.2・「詳細」パネル・
 * 盤面は emphasis 表示）を連絡と同作法で持つ。
 */
type Row = {
  /** 行の安定キー（並べ替え・「詳細」開閉を行に結ぶ描画用 id。保存対象外）。 */
  id: string;
  deadline: string;
  subject: string;
  task: string;
  /** 重要マーク（★・§5.2）。盤面は既存の連絡★と同一視覚（emphasis）で描く。 */
  isHighlight: boolean;
};

/** 行 state を保存ペイロード（AssignmentItem[]）に正規化する。dirty 判定と保存で同じ写像を使う。 */
function toAssignmentItems(rows: Row[]): AssignmentItem[] {
  return rows.map((r) => ({
    deadline: r.deadline,
    subject: r.subject,
    task: r.task,
    ...(r.isHighlight ? { isHighlight: true } : {}),
  }));
}

/**
 * 事前生成した「空行」か。締切は既定で対象日が入るので無視し、教員が入力する科目・提出物が**両方**空のとき空行。
 * 片方だけ入力（例: 科目だけ）の行は空行ではない＝従来どおり「未入力の項目があります」を出し、保存しない。
 */
function isBlankAssignmentRow(r: Row): boolean {
  return r.subject.trim() === "" && r.task.trim() === "" && !r.isHighlight;
}

/**
 * サーバ（`validateAssignmentItems`）と同じ**期限昇順の安定ソート**をクライアント側でも適用する（§5.1・
 * ドロップ後に見た目と保存結果を一致させる。同一期限内は配列順＝D&D 順を保つ）。
 */
function sortRowsLikeServer(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0));
}

export function AssignmentEditor({
  classId,
  target: targetProp,
  date,
  initialItems,
  onItemsChange,
  prefillRows = 0,
}: {
  classId?: string;
  target?: EditorTarget;
  date: string;
  initialItems: AssignmentItem[];
  /**
   * WYSIWYG ライブプレビュー連動（任意・追加 prop）。編集のたび現在の保存ペイロード相当（{@link toAssignmentItems}
   * 正規化後）を親へ通知する。**保存・検証・自動保存・RLS/監査の挙動には一切影響しない**（観測専用）。
   */
  onItemsChange?: (items: AssignmentItem[]) => void;
  /**
   * 盤面の規定枠ぶん**空行を事前生成**する数（{@link blockRowCapacity}）。既定 0（scope/ops 等は事前生成せず
   * 従来挙動）。空行（科目・提出物が両方空）は保存ペイロード・自動保存判定から除外され、保存をブロックしない。
   */
  prefillRows?: number;
}) {
  const target = toEditorTarget(targetProp, classId);
  // 対象校スコープ (system_admin の /ops 経路) を末尾引数に結ぶ。Provider 無し (=/app) なら従来動作 (回帰なし)。
  const { setAssignments } = useScopedDailyDataActions();
  const [rows, setRows] = useState<Row[]>(() =>
    padBlankRows(
      initialItems.map((i, idx) => ({
        id: `r${idx}`,
        deadline: i.deadline,
        subject: i.subject,
        task: i.task,
        isHighlight: i.isHighlight === true,
      })),
      prefillRows,
      // 事前生成の空行は提出期限を対象日で初期化（addRow と同じ既定。そのまま使えることが多い）。
      (index) => ({ id: `r${index}`, deadline: date, subject: "", task: "", isHighlight: false }),
    ),
  );
  // 新規行の安定キー用カウンタ（初期行 + 事前生成の空行は r0.. を使うので、その総数から続けて衝突しない）。
  const nextId = useRef(Math.max(initialItems.length, prefillRows));
  // 行ごとの「詳細（★重要）」開閉。**重要 ON の行は最初から開く**（設定済みを隠さない・連絡と同作法）。
  const disclosure = useRowDisclosure(
    initialItems
      .map((i, idx) => ({ id: `r${idx}`, has: i.isHighlight === true }))
      .filter((x) => x.has)
      .map((x) => x.id),
  );

  // 事前生成した空行（科目・提出物が両方空）は保存ペイロード・complete から除外する（空枠で保存をブロックせず、
  // 空の提出物を保存しない）。片方だけ入力した行は残り、従来どおり必須項目チェックの対象になる。
  const filledRows = rows.filter((r) => !isBlankAssignmentRow(r));
  const items = toAssignmentItems(filledRows);
  const serialized = serializeForDirty(items);
  // ライブプレビュー連動: 保存ペイロードが変わるたび親へ通知（観測専用・保存ロジックとは独立）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialized は items 変化のトリガ
  useEffect(() => {
    onItemsChange?.(items);
  }, [serialized, onItemsChange]);
  // 科目名・提出物名が空 / 締切が不正な行があるうちは保存しない（サーバ必須項目が揃った時点で自動保存）。
  const complete = filledRows.every(
    (r) => r.subject.trim().length > 0 && r.task.trim().length > 0 && isValidDate(r.deadline),
  );
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setAssignments(target.scope, targetId(target), date, toSave),
  });

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    const id = `r${nextId.current}`;
    nextId.current += 1;
    // 既定の提出期限は編集中の対象日 (そのまま使えることが多い)。
    setRows((prev) => [...prev, { id, deadline: date, subject: "", task: "", isHighlight: false }]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }
  // ⠿ 並べ替え（§5.1・同一期限内）: 行を from→to へ移した後、サーバと同じ期限昇順（安定）で再ソートして
  // 見た目と保存結果を一致させる（別期限へ跨いだドロップはスナップバック）。事前生成の空行はドロップ先に
  // しない・位置も保持（resortFilledRows）。
  function moveRow(from: number, to: number) {
    setRows((prev) => {
      const dest = prev[to];
      if (!dest || isBlankAssignmentRow(dest)) {
        return prev;
      }
      const moved = moveItem(prev, from, to);
      if (moved === prev) {
        return prev;
      }
      return resortFilledRows(moved, isBlankAssignmentRow, sortRowsLikeServer);
    });
  }
  const rowReorder = useRowReorder(rows.length, moveRow);
  // 並べ替えハンドルは**実入力行が 2 件以上**のときだけ出す（空行には出さない・1 件では並べ替え不要）。
  const reorderable = filledRows.length > 1;
  // Tab 縦移動（スプレッドシート風・共有フック {@link useGridTabNavigation}）。col: 0=科目 / 1=提出物。
  // 提出期限は native date ピッカー（内部セグメント間 Tab を残す）なので登録せず既定動作のまま。
  const { registerCell, onCellKeyDown } = useGridTabNavigation(rows.length, addRow);

  return (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: "640px" }}>
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle} aria-label="並べ替え" />
              <th style={thStyle}>提出期限</th>
              <th style={thStyle}>科目</th>
              <th style={thStyle}>提出物</th>
              <th style={thStyle} aria-label="詳細" />
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const reorder = rowReorder(i);
              const open = disclosure.isOpen(r.id);
              const detailId = `assignment-detail-${r.id}`;
              return (
                // 安定キー `r.id` で並べ替え時も行の同一性を保つ（連絡 / 来校者と同方式）。主役 `<tr>` と
                // 詳細 `<tr>` の 2 行を 1 行として束ねるため Fragment に key を置く。
                <Fragment key={r.id}>
                  {/* 主役行（期限 / 科目 / 提出物）。D&D / ↑↓ の対象はこの行だけ。 */}
                  <tr
                    {...reorder.rowProps}
                    style={{
                      ...(reorder.isDragging ? draggingRowStyle : {}),
                      ...(reorder.isOver ? dropOverRowStyle : {}),
                    }}
                  >
                    <td style={tdStyle}>
                      {reorderable && !isBlankAssignmentRow(r) ? (
                        <DragHandle reorder={reorder} label={`${i + 1} 件目を並べ替え`} />
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="date"
                        value={r.deadline}
                        onChange={(e) => update(i, { deadline: e.target.value })}
                        style={inputStyle}
                        aria-label={`${i + 1} 件目の提出期限`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        ref={(el) => registerCell(i, 0, el)}
                        value={r.subject}
                        onChange={(e) => update(i, { subject: e.target.value })}
                        onKeyDown={(e) => onCellKeyDown(e, i, 0)}
                        placeholder="科目名"
                        style={{ ...inputStyle, width: "100%" }}
                        aria-label={`${i + 1} 件目の科目名`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        ref={(el) => registerCell(i, 1, el)}
                        value={r.task}
                        onChange={(e) => update(i, { task: e.target.value })}
                        onKeyDown={(e) => onCellKeyDown(e, i, 1)}
                        placeholder="提出物の内容"
                        style={{ ...inputStyle, width: "100%" }}
                        aria-label={`${i + 1} 件目の提出物`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <RowDetailToggle
                        open={open}
                        hasValue={r.isHighlight}
                        onToggle={() => disclosure.toggle(r.id)}
                        controlsId={detailId}
                        label={`${i + 1} 件目の詳細項目`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        style={removeBtnStyle}
                        aria-label={`${i + 1} 件目を削除`}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                  {/* 詳細行（★重要・§5.2）。開いている時だけ描画。D&D のドロップ先にしないため rowProps を付けない。 */}
                  {open ? (
                    <tr>
                      <td colSpan={6} style={{ ...tdStyle, paddingTop: 0 }}>
                        <div id={detailId} style={detailPanelStyle}>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.25rem",
                              fontSize: "0.85rem",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={r.isHighlight}
                              onChange={(e) => update(i, { isHighlight: e.target.checked })}
                              aria-label={`${i + 1} 件目の重要マーク`}
                            />
                            重要
                          </label>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={saveBarStyle}>
        <button type="button" onClick={addRow} style={secondaryBtnStyle}>
          提出物を追加
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </div>
  );
}
