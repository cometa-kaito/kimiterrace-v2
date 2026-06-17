"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import type { EditorTarget, SchedulePeriod, ScheduleItem } from "@/lib/editor/schedule-core";
import {
  SCHEDULE_SLOT_OPTIONS,
  editorBasePath,
  isSpecialSlot,
  targetId,
} from "@/lib/editor/schedule-core";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useScopedDailyDataActions } from "./target-school";

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
  period: SchedulePeriod;
  subject: string;
  note: string;
  location: string;
  targetAudience: string;
};

/** select の値（文字列）を Row.period（number | 特殊スロット）に戻す。数値時限は number 化。 */
function parseSlotValue(value: string): SchedulePeriod {
  return isSpecialSlot(value) ? value : Number(value);
}

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
  onItemsChange,
}: {
  classId?: string;
  target?: EditorTarget;
  date: string;
  initialItems: ScheduleItem[];
  /**
   * WYSIWYG ライブプレビュー連動（任意・追加 prop）。行を編集するたび、現在の保存ペイロード相当
   * （{@link toScheduleItems} 正規化後）を親へ通知する。**保存・検証・自動保存・RLS/監査の挙動には一切
   * 影響しない**（観測専用の副作用。既定 undefined = 何もしない＝従来挙動）。
   */
  onItemsChange?: (items: ScheduleItem[]) => void;
}) {
  const target = toEditorTarget(targetProp, classId);
  // 対象校スコープ (system_admin の /ops 経路) を末尾引数に結ぶ。Provider 無し (=/app) なら従来動作 (回帰なし)。
  const { setSchedule } = useScopedDailyDataActions();
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
  // ライブプレビュー連動: 保存ペイロードが変わるたび親へ通知（レンダー後に副作用で。保存ロジックとは独立）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialized は items 変化のトリガ（items 直接 dep だと毎回新規参照で無限ループ）
  useEffect(() => {
    onItemsChange?.(items);
  }, [serialized, onItemsChange]);
  // 全行が有効（科目あり・時限が有効 slot＝1..12 または特殊スロット）かつ slot が重複しないなら自動保存。
  // 未入力/重複があるうちは保存しない（サーバが弾く＝保存失敗の error 状態になるのを避け、揃った時点で保存）。
  const periods = rows.map((r) => r.period);
  const complete =
    rows.every(
      (r) =>
        r.subject.trim().length > 0 &&
        (isSpecialSlot(r.period) ||
          (Number.isInteger(r.period) && r.period >= 1 && r.period <= 12)),
    ) && new Set(periods).size === periods.length;
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setSchedule(target.scope, targetId(target), date, toSave),
  });

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  // 安定参照（onCellKeyDown の依存・JSX 双方から使う）。次の空き番号は updater 内で prev から計算するので
  // rows に依存せず、Tab 縦移動の最終行追加でも常に最新行を基準にできる。挙動は従来と同一（数値時限のみ対象・
  // 特殊スロットは max 計算に含めない）。
  const addRow = useCallback(() => {
    setRows((prev) => {
      const numericPeriods = prev
        .map((r) => r.period)
        .filter((p): p is number => !isSpecialSlot(p));
      const nextPeriod = numericPeriods.length > 0 ? Math.max(...numericPeriods) + 1 : 1;
      return [
        ...prev,
        { period: nextPeriod, subject: "", note: "", location: "", targetAudience: "" },
      ];
    });
  }, []);
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  // --- Tab 縦移動（スプレッドシート風の連続入力） ---
  // 入力セルを `row:col` でキー登録した ref マップ。Tab で同じ列の次の行へ（縦移動）フォーカスを移す。
  // col: 0=時限 / 1=科目 / 2=補足 / 3=場所 / 4=対象者。保存/検証/RLS/監査の挙動には一切触れない（フォーカス制御のみ）。
  const cellRefs = useRef(new Map<string, HTMLElement>());
  // 新規行追加直後にフォーカスしたいセル（addRow は非同期に行が増えるため、描画後 effect で当てる）。
  const pendingFocusRef = useRef<{ row: number; col: number } | null>(null);

  const registerCell = useCallback((row: number, col: number, el: HTMLElement | null) => {
    const key = `${row}:${col}`;
    if (el) {
      cellRefs.current.set(key, el);
    } else {
      cellRefs.current.delete(key);
    }
  }, []);

  const focusCell = useCallback((row: number, col: number): boolean => {
    const el = cellRefs.current.get(`${row}:${col}`);
    if (el) {
      el.focus();
      return true;
    }
    return false;
  }, []);

  // 行数が変わった後（addRow で増えた直後）に保留中のフォーカスを当てる。当たらなければ何もしない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 行数(rows.length)変化を effect の起動条件にする
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending && focusCell(pending.row, pending.col)) {
      pendingFocusRef.current = null;
    }
  }, [rows.length, focusCell]);

  // 予定テーブルの Tab を縦移動にする。Tab=同 col の次行 / Shift+Tab=同 col の前行。最終行で Tab を押したら
  // 新規行を追加して同 col にフォーカス（連続入力を速く）。先頭行で Shift+Tab・端の列は既定動作に委ねる
  //（フォーカストラップを作らない＝削除ボタンや画面外への離脱を妨げない）。
  const onCellKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>, row: number, col: number) => {
      if (e.key !== "Tab") {
        return;
      }
      if (e.shiftKey) {
        // 前の行の同じ列へ。先頭行なら既定動作（前の列/前要素へ）に委ねる。
        if (row > 0) {
          e.preventDefault();
          focusCell(row - 1, col);
        }
        return;
      }
      // 下の行の同じ列へ。最終行なら新規行を追加して同 col にフォーカスする。
      e.preventDefault();
      if (row < rows.length - 1) {
        focusCell(row + 1, col);
      } else {
        pendingFocusRef.current = { row: row + 1, col };
        addRow();
      }
    },
    [rows.length, focusCell, addRow],
  );

  async function changeDate(next: string) {
    // 未保存分があれば確実に保存してから対象日を切り替える（自動保存 debounce の取りこぼし防止・順序維持）。
    if (auto.dirty) {
      await auto.flush();
    }
    // scroll: false で App Router 既定のページ先頭スクロールリセットを抑止し、対象日変更後も予定エディタの
    // 位置に留まる（key={date} 再マウントは維持）。保存/RLS/監査の挙動には触れない。
    router.push(`${editorBasePath(target)}?date=${next}`, { scroll: false });
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
                  <select
                    ref={(el) => registerCell(i, 0, el)}
                    value={String(r.period)}
                    onChange={(e) => update(i, { period: parseSlotValue(e.target.value) })}
                    onKeyDown={(e) => onCellKeyDown(e, i, 0)}
                    style={{ ...inputStyle, width: "6rem" }}
                    aria-label={`${i + 1} 行目の時限`}
                  >
                    {SCHEDULE_SLOT_OPTIONS.map((opt) => (
                      <option key={String(opt.value)} value={String(opt.value)}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={tdStyle}>
                  <input
                    ref={(el) => registerCell(i, 1, el)}
                    value={r.subject}
                    onChange={(e) => update(i, { subject: e.target.value })}
                    onKeyDown={(e) => onCellKeyDown(e, i, 1)}
                    placeholder="科目名"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の科目名`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    ref={(el) => registerCell(i, 2, el)}
                    value={r.note}
                    onChange={(e) => update(i, { note: e.target.value })}
                    onKeyDown={(e) => onCellKeyDown(e, i, 2)}
                    placeholder="(任意)"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の補足`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    ref={(el) => registerCell(i, 3, el)}
                    value={r.location}
                    onChange={(e) => update(i, { location: e.target.value })}
                    onKeyDown={(e) => onCellKeyDown(e, i, 3)}
                    placeholder="(任意) 体育館 等"
                    style={{ ...inputStyle, width: "100%" }}
                    aria-label={`${i + 1} 行目の場所`}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    ref={(el) => registerCell(i, 4, el)}
                    value={r.targetAudience}
                    onChange={(e) => update(i, { targetAudience: e.target.value })}
                    onKeyDown={(e) => onCellKeyDown(e, i, 4)}
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
