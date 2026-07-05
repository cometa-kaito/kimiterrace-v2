"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { padBlankRows } from "@/lib/editor/prefill-rows";
import type { NoticeItem } from "@/lib/editor/notice-assignment-core";
import type { EditorTarget } from "@/lib/editor/schedule-core";
import { DIVIDER_LABEL_MAX, targetId } from "@/lib/editor/schedule-core";
import { tokens } from "@kimiterrace/ui";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { AutoSaveStatusText } from "./AutoSaveStatusText";
import { DragHandle } from "./DragHandle";
import {
  blankRowStyle,
  detailPanelStyle,
  draggingRowStyle,
  dropOverRowStyle,
  inputStyle,
  primaryBtnStyle,
  removeBtnStyle,
  saveBarStyle,
  subtleBtnStyle,
} from "./editor-styles";
import { RowDetailToggle, useRowDisclosure } from "./RowDetails";
import { toEditorTarget } from "./target";
import { useScopedDailyDataActions } from "./target-school";
import { useGridTabNavigation } from "./useGridTabNavigation";
import { moveItem, useRowReorder } from "./useRowReorder";

/**
 * 連絡 (お知らせ) エディタ (#48-I、段A-2 で scope 汎用化)。**Client Component** — 件の追加/削除/編集を
 * 行い、変更時に `setNoticesAction` を target (学校/学科/学年/クラス) 付きで**自動保存**する。検証・認可・
 * 監査・RLS は Server Action 側が担保するので、ここは入力収集と結果表示に徹する。
 *
 * `target` を渡すと任意 scope を編集できる。後方互換のため `classId` だけ渡されたらクラス編集になる。
 *
 * #243 (②UI-UX): 各連絡に「表示日数」(入力日を起点に何日間サイネージに出すか) を持たせる。プリセット
 * (今日のみ/明日まで/3日間/1週間) + カスタム (1..14)。既定は今日のみ (1)。
 * UIUX（保存ボタン廃止）: 追加・編集・削除した時点で自動保存（{@link useAutoSaveSection}）。本文が空の
 * 行があるうちは保存しない（入力が揃った時点で保存）。
 *
 * D 群（並べ替え）: 連絡は **配列順 = サイネージ表示順**（`validateNoticeItems` が入力順を保持し、盤面も
 * 同じ配列順で描画する）ため、行を**ドラッグ&ドロップ**で並べ替えると、その順序が既存の自動保存経路で
 * そのまま保存・反映される（migration 不要・盤面の表示物は増減しない＝順序だけ変わる）。操作はマウス/
 * タッチ/ペン共通のポインタ D&D ＋ フォーカス時の ↑↓ キー（要望 2026-06-23: 上下ボタンは廃止・
 * {@link DragHandle} / {@link useRowReorder}）。時刻/時限でサーバ再ソートされる予定・提出物・来校者・
 * 呼び出しは本機構の対象外（盤面順を変えないため）。
 */
type Row = {
  id: string;
  /**
   * 行タイプ（PR-B §5.3）。"divider"=区切り線＝「本文が罫線であるだけの行」。text を任意ラベルとして使い、
   * **表示日数は通常行と同じライフサイクル**を持つ（多日連絡のグルーピングを翌日崩さない）。重要のみ持たない。
   */
  kind?: "divider";
  text: string;
  isHighlight: boolean;
  displayDays: number;
  custom: boolean;
  /**
   * 固定表示（「ずっと」・F-C §5.4）。表示日数 select の独立 option（値 "pinned"）で選び、保存時に
   * `pinned: true` へ写像する（displayDays は保存しない＝排他は validate が確定）。divider 行にも許可
   * （「区切り線ごと固定」）。
   */
  pinned: boolean;
};

/** 表示日数のプリセット (入力日を起点に N 日間)。これ以外は「カスタム」で 1..14 を直接指定。 */
const DISPLAY_DAYS_PRESETS = [
  { value: 1, label: "今日のみ" },
  { value: 2, label: "明日まで" },
  { value: 3, label: "3日間" },
  { value: 7, label: "1週間" },
] as const;
const PRESET_VALUES = new Set<number>(DISPLAY_DAYS_PRESETS.map((p) => p.value));
const DISPLAY_DAYS_MAX = 14;

function clampDisplayDays(n: number): number {
  if (!Number.isFinite(n)) {
    return 1;
  }
  return Math.min(DISPLAY_DAYS_MAX, Math.max(1, Math.round(n)));
}

/**
 * 任意設定（重要 / 表示日数 / 固定）が**既定でない**か。重要 ON / 表示日数が 1（今日のみ）以外 / プリセット外
 * （カスタム）/ 固定（ずっと）のいずれかなら詳細を初期から開く（設定済みを隠さない・{@link useRowDisclosure}）。
 * 折りたたみ中の「設定あり」表示にも使う。
 */
function hasNoticeDetail(r: {
  isHighlight: boolean;
  displayDays: number;
  pinned: boolean;
}): boolean {
  return r.isHighlight || r.pinned || r.displayDays !== 1 || !PRESET_VALUES.has(r.displayDays);
}

/** 行 state を保存ペイロード（NoticeItem[]）に正規化する。dirty 判定と保存で同じ写像を使う。 */
function toNoticeItems(rows: Row[]): NoticeItem[] {
  return rows.map((r) =>
    // 区切り線（§5.3）: text を任意ラベル（trim・空可）として保存。表示日数/固定は通常行と同じライフサイクル
    // （既定 1 は省略・pinned は displayDays と排他）。重要のみ載せない（罫線に強調概念なし・validate も剥がす）。
    r.kind === "divider"
      ? {
          kind: "divider" as const,
          text: r.text.trim(),
          ...(r.pinned
            ? { pinned: true }
            : r.displayDays > 1
              ? { displayDays: r.displayDays }
              : {}),
        }
      : {
          text: r.text,
          ...(r.isHighlight ? { isHighlight: true } : {}),
          // 固定（ずっと・§5.4）は displayDays を保存しない（排他）。既定 1 (今日のみ) は省略して保存
          // (JSONB 最小化・後方互換)。
          ...(r.pinned
            ? { pinned: true }
            : r.displayDays > 1
              ? { displayDays: r.displayDays }
              : {}),
        },
  );
}

const detailLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.25rem",
  fontSize: "0.85rem",
};

/**
 * 表示日数（プリセット + カスタム 1..14 + ずっと＝固定表示）の選択 UI。通常行と区切り線行の詳細パネルで
 * 共有する（§5.3: 区切り線も通常行と同じ表示期間ライフサイクルを持つため、同じ選択肢・同じ挙動で出す。
 * §5.4: 「ずっと」は日数プリセットの一種ではなく**固定**という別概念なので、独立 option・値は "pinned"
 * 番兵 → 保存時に `pinned: true` へ写像する）。
 *
 * **「ずっと」はクラス scope のエディタ限定**（`allowPinned`・2026-07-04 Reviewer HIGH-1）: pinned の削除
 * 導線（PinnedNoticesList）はクラスエディタにしか無いため、scope（学校/学科/学年）・ops エディタでは
 * option 自体を出さず「消せない幽霊」を構造的に作れなくする。既存データが pinned の行は例外として option を
 * 出す（fail-soft: 現在値の表示と「ずっと」からの解除を可能にする。他の値へ変えると option は消える）。
 */
function DisplayDaysField({
  row,
  index,
  allowPinned,
  onPatch,
}: {
  row: Row;
  index: number;
  allowPinned: boolean;
  onPatch: (patch: Partial<Row>) => void;
}) {
  return (
    <>
      <label style={detailLabelStyle}>
        表示
        <select
          value={row.pinned ? "pinned" : row.custom ? "custom" : String(row.displayDays)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "pinned") {
              onPatch({ pinned: true });
            } else if (v === "custom") {
              onPatch({ pinned: false, custom: true });
            } else {
              onPatch({ pinned: false, custom: false, displayDays: Number(v) });
            }
          }}
          style={inputStyle}
          aria-label={`${index + 1} 件目の表示日数`}
        >
          {DISPLAY_DAYS_PRESETS.map((p) => (
            <option key={p.value} value={String(p.value)}>
              {p.label}
            </option>
          ))}
          <option value="custom">カスタム</option>
          {allowPinned || row.pinned ? <option value="pinned">ずっと（固定表示）</option> : null}
        </select>
      </label>
      {row.custom && !row.pinned ? (
        <label style={detailLabelStyle}>
          <input
            type="number"
            min={1}
            max={DISPLAY_DAYS_MAX}
            value={row.displayDays}
            onChange={(e) => onPatch({ displayDays: clampDisplayDays(Number(e.target.value)) })}
            style={{ ...inputStyle, width: "4rem" }}
            aria-label={`${index + 1} 件目の表示日数 (日)`}
          />
          日間
        </label>
      ) : null}
    </>
  );
}

export function NoticeEditor({
  classId,
  target: targetProp,
  date,
  initialItems,
  onItemsChange,
  prefillRows = 0,
  allowPinned = false,
}: {
  classId?: string;
  target?: EditorTarget;
  date: string;
  initialItems: NoticeItem[];
  /**
   * WYSIWYG ライブプレビュー連動（任意・追加 prop）。編集のたび現在の保存ペイロード相当（{@link toNoticeItems}
   * 正規化後）を親へ通知する。**保存・検証・自動保存・RLS/監査の挙動には一切影響しない**（観測専用）。
   */
  onItemsChange?: (items: NoticeItem[]) => void;
  /**
   * 盤面の規定枠ぶん**空行を事前生成**する数（{@link blockRowCapacity}）。既定 0（scope/ops 等は事前生成せず
   * 従来挙動）。空行（本文が空）は保存ペイロード・自動保存判定から除外され、埋めなくても保存をブロックしない。
   */
  prefillRows?: number;
  /**
   * 「ずっと（固定表示）」option を出すか（§5.4・2026-07-04 Reviewer HIGH-1）。**削除導線
   * （PinnedNoticesList）を持つクラスエディタ（/app・WysiwygBoardEditor 経由）だけが true を渡す**。
   * 既定 false（scope=学校/学科/学年・/ops エディタ）では新規に固定を選べない（既存 pinned 行の表示・解除は
   * fail-soft で可能）。保存経路側の防御は setNoticesAction の `allowPinned: scope==="class"` が担う（二層）。
   */
  allowPinned?: boolean;
}) {
  const target = toEditorTarget(targetProp, classId);
  // 対象校スコープ (system_admin の /ops 経路) を末尾引数に結ぶ。Provider 無し (=/app) なら従来動作 (回帰なし)。
  const { setNotices } = useScopedDailyDataActions();
  const [rows, setRows] = useState<Row[]>(() =>
    padBlankRows(
      initialItems.map((i, idx) => {
        const dd = i.displayDays ?? 1;
        return {
          id: `r${idx}`,
          ...(i.kind === "divider" ? { kind: "divider" as const } : {}),
          text: i.text,
          isHighlight: i.isHighlight ?? false,
          displayDays: dd,
          custom: !PRESET_VALUES.has(dd),
          pinned: i.pinned === true,
        };
      }),
      prefillRows,
      (index) => ({
        id: `r${index}`,
        text: "",
        isHighlight: false,
        displayDays: 1,
        custom: false,
        pinned: false,
      }),
    ),
  );
  // 新規行の安定キー用カウンタ。初期行 + 事前生成の空行は r0.. を使うので、その総数から続けて衝突しない。
  const nextId = useRef(Math.max(initialItems.length, prefillRows));
  // 行ごとの「詳細（任意設定）」開閉。**既定でない設定（重要 / 表示日数>1 / カスタム）の行は最初から開く**
  // （設定済みを隠さない）。初期 id 付番（`r${idx}`）と一致させる（state 初期化と同じ index 基準）。
  const disclosure = useRowDisclosure(
    initialItems
      .map((i, idx) => ({
        id: `r${idx}`,
        has: hasNoticeDetail({
          isHighlight: i.isHighlight ?? false,
          displayDays: i.displayDays ?? 1,
          pinned: i.pinned === true,
        }),
      }))
      .filter((x) => x.has)
      .map((x) => x.id),
  );

  // 事前生成した空行（本文が空）は保存ペイロード・complete・並べ替え対象から除外する（空枠で保存をブロックせず、
  // 空の連絡を保存しない／空行を掴ませない）。教員が埋めた行だけが盤面・保存に反映される。
  // **区切り線はラベルが空でも実体行**（教員が意図して挿入した罫線・§5.3）＝保存・並べ替えの対象に残す。
  const filledRows = rows.filter((r) => r.kind === "divider" || r.text.trim().length > 0);
  // 並べ替えハンドルは**本文の入った行が 2 件以上**のときだけ各実入力行に出す（空行には出さない・1 件では並べ替え不要）。
  const reorderable = filledRows.length > 1;
  const items = toNoticeItems(filledRows);
  const serialized = serializeForDirty(items);
  // ライブプレビュー連動: 保存ペイロードが変わるたび親へ通知（観測専用・保存ロジックとは独立）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialized は items 変化のトリガ
  useEffect(() => {
    onItemsChange?.(items);
  }, [serialized, onItemsChange]);
  // 本文の入った行はそれ自体で有効（連絡は本文のみ必須）＝埋まった行があれば自動保存する。
  // 区切り線はラベル空でも有効（本文必須なし・§5.3）。
  const complete = filledRows.every((r) => r.kind === "divider" || r.text.trim().length > 0);
  const auto = useAutoSaveSection({
    serialized,
    items,
    complete,
    save: (toSave) => setNotices(target.scope, targetId(target), date, toSave),
  });

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function addRow() {
    const id = `r${nextId.current}`;
    nextId.current += 1;
    setRows((prev) => [
      ...prev,
      { id, text: "", isHighlight: false, displayDays: 1, custom: false, pinned: false },
    ]);
  }
  // 区切り線を末尾に追加（§5.3・行追加ボタンの脇）。ラベルは任意（空なら純粋な罫線）。位置は ⠿ で動かす。
  function addDividerRow() {
    const id = `r${nextId.current}`;
    nextId.current += 1;
    setRows((prev) => [
      ...prev,
      {
        id,
        kind: "divider" as const,
        text: "",
        isHighlight: false,
        displayDays: 1,
        custom: false,
        pinned: false,
      },
    ]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }
  // 並べ替え（D 群）: 行を from→to へ移す。並べ替え後の配列順がそのまま保存ペイロード順になり、
  // 既存の自動保存（dirty 判定 = serialized 変化）が走って保存・盤面反映される（順序のみ変更）。
  function moveRow(from: number, to: number) {
    setRows((prev) => moveItem(prev, from, to));
  }
  const rowReorder = useRowReorder(rows.length, moveRow);
  // Tab 縦移動（スプレッドシート風・共有フック {@link useGridTabNavigation}）。連絡は本文 1 列なので col 0 のみ
  // （本文で Tab → 次の行の本文へ。最終行で行追加）。重要チェック / 表示日数は「詳細」パネルに畳んだ任意設定なので
  // 登録せず通常 Tab に委ねる（開いている時だけ存在）。
  const { registerCell, onCellKeyDown } = useGridTabNavigation(rows.length, addRow);

  return (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: "720px" }}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
        {rows.map((r, i) => {
          const reorder = rowReorder(i);
          const open = disclosure.isOpen(r.id);
          const detailId = `notice-detail-${r.id}`;
          // 区切り線行（§5.3）: 本文入力の代わりにラベル入力（任意）と ⠿・詳細（表示日数）・削除を出す。
          // 表示日数は通常行と同じライフサイクル（多日連絡のグルーピングを翌日崩さない）。重要のみ出さない。
          if (r.kind === "divider") {
            return (
              <li
                key={r.id}
                {...reorder.rowProps}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  flexWrap: "wrap",
                  ...(reorder.isDragging ? draggingRowStyle : {}),
                  ...(reorder.isOver ? dropOverRowStyle : {}),
                }}
              >
                {reorderable ? (
                  <DragHandle reorder={reorder} label={`${i + 1} 件目を並べ替え`} />
                ) : null}
                <span aria-hidden="true" style={{ color: tokens.color.muted }}>
                  ── 区切り線
                </span>
                <input
                  // Tab 縦移動のグリッドに穴を作らない: 本文列（col0）の縦移動でこのラベル入力に着地させる。
                  ref={(el) => registerCell(i, 0, el)}
                  value={r.text}
                  onChange={(e) => update(i, { text: e.target.value })}
                  onKeyDown={(e) => onCellKeyDown(e, i, 0)}
                  placeholder="ラベル（省略可）"
                  maxLength={DIVIDER_LABEL_MAX}
                  style={{ ...inputStyle, width: "12rem" }}
                  aria-label={`${i + 1} 件目の区切り線ラベル`}
                />
                <RowDetailToggle
                  open={open}
                  hasValue={hasNoticeDetail(r)}
                  onToggle={() => disclosure.toggle(r.id)}
                  controlsId={detailId}
                  label={`${i + 1} 件目の詳細項目`}
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  style={removeBtnStyle}
                  className="kt-row-delete"
                  aria-label={`${i + 1} 件目を削除`}
                >
                  削除
                </button>
                {/* 詳細（表示日数のみ・重要は罫線に概念なし）。通常行と同じ全幅パネル。 */}
                {open ? (
                  <div id={detailId} style={{ ...detailPanelStyle, flexBasis: "100%" }}>
                    <DisplayDaysField
                      row={r}
                      index={i}
                      allowPinned={allowPinned}
                      onPatch={(patch) => update(i, patch)}
                    />
                  </div>
                ) : null}
              </li>
            );
          }
          return (
            <li
              key={r.id}
              {...reorder.rowProps}
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
                flexWrap: "wrap",
                // 空行は薄く（#3 記入済みだけ濃く）。本文を入力すると濃くなる。
                ...(r.text.trim() === "" ? blankRowStyle : {}),
                ...(reorder.isDragging ? draggingRowStyle : {}),
                ...(reorder.isOver ? dropOverRowStyle : {}),
              }}
            >
              {reorderable && r.text.trim().length > 0 ? (
                <DragHandle reorder={reorder} label={`${i + 1} 件目を並べ替え`} />
              ) : null}
              {/* 主役（連絡事項）。重要 / 表示日数は「詳細」に畳む。 */}
              <input
                ref={(el) => registerCell(i, 0, el)}
                value={r.text}
                onChange={(e) => update(i, { text: e.target.value })}
                onKeyDown={(e) => onCellKeyDown(e, i, 0)}
                placeholder="連絡事項"
                style={{ ...inputStyle, flex: 1, minWidth: "12rem" }}
                aria-label={`${i + 1} 件目の連絡事項`}
              />
              {/* 空行では詳細/削除の chrome を畳む（#1/#3: 反復ボタン壁を減らし空行を軽くする）。本文を入力
                  すると行が「空でない」になり詳細/削除が現れる。 */}
              {r.text.trim() !== "" ? (
                <>
                  <RowDetailToggle
                    open={open}
                    hasValue={hasNoticeDetail(r)}
                    onToggle={() => disclosure.toggle(r.id)}
                    controlsId={detailId}
                    label={`${i + 1} 件目の詳細項目`}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    style={removeBtnStyle}
                    className="kt-row-delete"
                    aria-label={`${i + 1} 件目を削除`}
                  >
                    削除
                  </button>
                </>
              ) : null}
              {/* 詳細（重要 / 表示日数）。開いている時だけ、行下に全幅で開く（flexBasis:100% で次行へ折返す）。
                  重要 / 表示日数の onChange ロジックは従来と同一（挙動不変・畳んでも state は保持）。 */}
              {open ? (
                <div id={detailId} style={{ ...detailPanelStyle, flexBasis: "100%" }}>
                  <label style={detailLabelStyle}>
                    <input
                      type="checkbox"
                      checked={r.isHighlight}
                      onChange={(e) => update(i, { isHighlight: e.target.checked })}
                    />
                    重要
                  </label>
                  <DisplayDaysField
                    row={r}
                    index={i}
                    allowPinned={allowPinned}
                    onPatch={(patch) => update(i, patch)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div style={saveBarStyle}>
        <button type="button" onClick={addRow} style={primaryBtnStyle}>
          連絡を追加
        </button>
        {/* 区切り線（§5.3）: 主アクション（連絡を追加＝塗り）と差をつける三次アクション（#4 ボタン階層）。 */}
        <button type="button" onClick={addDividerRow} style={subtleBtnStyle}>
          ＋区切り線
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </div>
  );
}
