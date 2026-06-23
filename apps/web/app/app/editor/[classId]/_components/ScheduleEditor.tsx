"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { padBlankRows } from "@/lib/editor/prefill-rows";
import type { EditorTarget, SchedulePeriod, ScheduleItem } from "@/lib/editor/schedule-core";
import {
  CUSTOM_PERIOD_MAX,
  SCHEDULE_SLOT_OPTIONS,
  editorBasePath,
  isCustomPeriod,
  isSpecialSlot,
  targetId,
} from "@/lib/editor/schedule-core";
import { tokens } from "@kimiterrace/ui";
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

/** 「その他（自由入力）」を表す select の番兵値（実 period 値ではない・UI 専用）。 */
const CUSTOM_SLOT_VALUE = "__custom__";

/**
 * 時限が「未選択（空欄）」を表す番兵（UI 専用）。`0` は有効時限(1..12)でも特殊スロットでもないので
 * {@link isRowPeriodComplete} が false を返し、時限を選ぶまで保存・盤面表示をブロックする（要望 2026-06-23:
 * 事前生成・新規行の時限は最初は空欄＝1限〜5限 を自動で入れない）。`ScheduleItem.period` は number のままで
 * 型・スキーマ・サーバ検証は不変（`normalizePeriod` も 0 を弾く）。
 */
const UNSELECTED_PERIOD = 0;

/** select の値（文字列）を Row.period に戻す。空=未選択 / 「その他」=空の自由入力 / 特殊はそのまま / それ以外は数値化。 */
function parseSlotValue(value: string): SchedulePeriod {
  if (value === "") {
    return UNSELECTED_PERIOD;
  }
  if (value === CUSTOM_SLOT_VALUE) {
    return { custom: "" };
  }
  return isSpecialSlot(value) ? value : Number(value);
}

/** Row.period を select の現在値（文字列）へ。未選択=空 / その他=番兵 / 特殊・数値はその文字列。 */
function slotSelectValue(period: SchedulePeriod): string {
  if (isCustomPeriod(period)) {
    return CUSTOM_SLOT_VALUE;
  }
  if (period === UNSELECTED_PERIOD) {
    return "";
  }
  return String(period);
}

/**
 * 行の時限が「保存してよい」状態か。数値 1..12 / 特殊スロット / 中身のある自由入力。
 *
 * **上限は 12 のまま**にする。新規入力の構造化選択肢は 1〜6 限のみに絞った（{@link SCHEDULE_SLOT_OPTIONS}・
 * 2026-06-23 要望）が、過去に保存された 7〜12 限の行をここで「未完了」と見なすと自動保存をブロックして
 * しまうため。サーバ検証（`normalizePeriod`）と同じく 1〜12 を許容し、既存データを壊さない。
 */
function isRowPeriodComplete(period: SchedulePeriod): boolean {
  if (isCustomPeriod(period)) {
    return period.custom.trim().length > 0;
  }
  if (isSpecialSlot(period)) {
    return true;
  }
  return Number.isInteger(period) && period >= 1 && period <= 12;
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

/**
 * 事前生成した「空行」か（保存ペイロード・complete から除外する判定）。時限は既定値を持つので無視し、教員が
 * 入力しうるテキスト欄（科目 / 補足 / 場所 / 対象者）がすべて空、かつ「その他（自由入力）」の時限ラベルも空の
 * ときだけ空行とみなす。部分入力（例: 科目未入力で場所だけ入れた）は空行ではない＝従来どおり「未入力の項目が
 * あります」を出し、空の予定を保存しない。
 */
function isBlankScheduleRow(r: Row): boolean {
  const noText =
    r.subject.trim() === "" &&
    r.note.trim() === "" &&
    r.location.trim() === "" &&
    r.targetAudience.trim() === "";
  const customLabel = isCustomPeriod(r.period) && r.period.custom.trim().length > 0;
  return noText && !customLabel;
}

/** 曜日（日始まり）。日付文字列から決まり today に依存しないので SSR/クライアントで一致する。 */
const WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** "2026-06-23" → "2026年6月23日（火）"。対象日を切り替えない場面（クラス編集）で日付を読みやすく示す。 */
function formatEditorDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) {
    return date;
  }
  const weekday = WEEKDAY_JP[new Date(y, m - 1, d).getDay()] ?? "";
  return `${y}年${m}月${d}日（${weekday}）`;
}

export function ScheduleEditor({
  classId,
  target: targetProp,
  date,
  initialItems,
  onItemsChange,
  showDateNav = true,
  prefillRows = 0,
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
  /**
   * 対象日ナビ（`<input type="date">`）を出すか。既定 true（scope/ops エディタは従来どおりここで日付を切替）。
   * クラス編集はページ最下部の常設カレンダーが日付ナビを担うので false にし、編集中の日付をテキスト表示する
   * だけにする（要望 2026-06-23: 予定セクションの対象日設定は廃止し日付を書いておく）。
   */
  showDateNav?: boolean;
  /**
   * 盤面の規定枠ぶん**空行を事前生成**する数（{@link blockRowCapacity}）。教員が「盤面に出る予定の枠」を入力前
   * から把握できるよう、最初から空の入力行を並べる。既定 0（scope/ops エディタ等は事前生成せず従来挙動）。
   * 空行は保存ペイロード・自動保存判定から除外されるので、埋めなくても保存をブロックしない（{@link isBlankScheduleRow}）。
   */
  prefillRows?: number;
}) {
  const target = toEditorTarget(targetProp, classId);
  // 対象校スコープ (system_admin の /ops 経路) を末尾引数に結ぶ。Provider 無し (=/app) なら従来動作 (回帰なし)。
  const { setSchedule } = useScopedDailyDataActions();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => {
    const initial: Row[] = initialItems.map((i) => ({
      period: i.period,
      subject: i.subject,
      note: i.note ?? "",
      location: i.location ?? "",
      targetAudience: i.targetAudience ?? "",
    }));
    // 盤面の規定枠（prefillRows）まで空行を足す。時限は**未選択（空欄）**で始める（自動で 1限〜5限 を割り当て
    // ない・要望 2026-06-23）。教員が各行を埋めるとき時限を選ぶ。prefillRows=0（scope/ops 等）は no-op で従来どおり。
    return padBlankRows(initial, prefillRows, () => ({
      period: UNSELECTED_PERIOD,
      subject: "",
      note: "",
      location: "",
      targetAudience: "",
    }));
  });

  // 事前生成した空行（{@link isBlankScheduleRow}）は保存ペイロード・complete から除外する。教員が触れていない
  // 空枠で自動保存をブロックせず、空の予定も保存しない（埋めた行だけが盤面・保存に反映）。部分入力行は残る。
  const filledRows = rows.filter((r) => !isBlankScheduleRow(r));
  const items = toScheduleItems(filledRows);
  const serialized = serializeForDirty(items);
  // ライブプレビュー連動: **時限が確定した行だけ**盤面へ通知する（未選択=0 の行は "0限" を盤面に出さない）。
  // 保存ロジックとは独立（レンダー後に副作用で）。
  const previewItems = items.filter((it) => isRowPeriodComplete(it.period));
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialized は items 変化のトリガ（items 直接 dep だと毎回新規参照で無限ループ）
  useEffect(() => {
    onItemsChange?.(previewItems);
  }, [serialized, onItemsChange]);
  // 埋めた行が全て有効（科目あり・時限が有効 slot＝1..12 または特殊スロット）かつ **数値時限**が重複しないなら自動保存。
  // 未入力/数値時限の重複があるうちは保存しない（サーバが弾く＝保存失敗の error 状態になるのを避け、揃った時点で保存）。
  // 特殊スロット（朝 / 昼休み / 放課後）は重複を許容する（例: 放課後に部活と三者面談）＝サーバ検証と整合。
  // 以前はここで全 period を一律に重複扱いしていたため、放課後を 2 つ入れると complete=false で**保存されなかった**
  // （要望: 放課後が 2 つあると反映されない、の是正 2026-06-22）。
  // 重複判定は**有効な数値時限(1..12)のみ**。未選択(0)は除外する（複数行が未選択でも重複扱いにしない）。
  const numberedPeriods = filledRows
    .map((r) => r.period)
    .filter((p): p is number => typeof p === "number" && p >= 1);
  const complete =
    filledRows.every((r) => r.subject.trim().length > 0 && isRowPeriodComplete(r.period)) &&
    new Set(numberedPeriods).size === numberedPeriods.length;
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
    // 新規行も時限は未選択（空欄）で始める（自動採番しない・事前生成行と一貫・要望 2026-06-23）。
    setRows((prev) => [
      ...prev,
      { period: UNSELECTED_PERIOD, subject: "", note: "", location: "", targetAudience: "" },
    ]);
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
      {showDateNav ? (
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          対象日
          <input
            type="date"
            value={date}
            onChange={(e) => changeDate(e.target.value)}
            style={inputStyle}
          />
        </label>
      ) : (
        // クラス編集では対象日はカレンダーで切替。ここは編集中の日付をテキストで示すだけ（要望 2026-06-23）。
        <p
          style={{
            margin: 0,
            fontSize: tokens.fontSize.md,
            fontWeight: 600,
            color: tokens.color.ink,
          }}
        >
          {formatEditorDate(date)}
        </p>
      )}

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
                    value={slotSelectValue(r.period)}
                    onChange={(e) => update(i, { period: parseSlotValue(e.target.value) })}
                    onKeyDown={(e) => onCellKeyDown(e, i, 0)}
                    style={{ ...inputStyle, width: "6rem" }}
                    aria-label={`${i + 1} 行目の時限`}
                  >
                    {/* 未選択（空欄）。事前生成・新規行はここで始まり、時限を選ぶまで盤面に出ない。 */}
                    <option value="">（時限を選択）</option>
                    {SCHEDULE_SLOT_OPTIONS.map((opt) => (
                      <option key={String(opt.value)} value={String(opt.value)}>
                        {opt.label}
                      </option>
                    ))}
                    {/* 「その他」を選ぶと下に自由入力欄が出る（番兵値・実 period ではない）。 */}
                    <option value={CUSTOM_SLOT_VALUE}>その他</option>
                  </select>
                  {isCustomPeriod(r.period) ? (
                    <input
                      value={r.period.custom}
                      onChange={(e) => update(i, { period: { custom: e.target.value } })}
                      placeholder="例: 補習"
                      maxLength={CUSTOM_PERIOD_MAX}
                      style={{ ...inputStyle, width: "6rem", marginTop: "0.25rem" }}
                      aria-label={`${i + 1} 行目の時限（自由入力）`}
                    />
                  ) : null}
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
          予定を追加
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </div>
  );
}
