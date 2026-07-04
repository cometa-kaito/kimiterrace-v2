"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { padBlankRows } from "@/lib/editor/prefill-rows";
import type { EditorTarget, SchedulePeriod, ScheduleItem } from "@/lib/editor/schedule-core";
import {
  CUSTOM_PERIOD_MAX,
  DIVIDER_LABEL_MAX,
  SCHEDULE_SLOT_OPTIONS,
  editorBasePath,
  isCustomPeriod,
  isSpecialSlot,
  scheduleSlotSortKey,
  sortScheduleSegments,
  targetId,
} from "@/lib/editor/schedule-core";
import { tokens } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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
import { DetailField, RowDetailToggle, useRowDisclosure } from "./RowDetails";
import { toEditorTarget } from "./target";
import { useScopedDailyDataActions } from "./target-school";
import { useGridTabNavigation } from "./useGridTabNavigation";
import { moveItem, resortFilledRows, useRowReorder } from "./useRowReorder";

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
  /** 行の安定キー（「詳細」開閉状態を行に結ぶための描画用 id。保存対象外）。 */
  id: string;
  /** 行タイプ（PR-B §5.3）。"divider"=区切り線（subject を任意ラベルとして使い、時限・詳細は持たない）。 */
  kind?: "divider";
  period: SchedulePeriod;
  subject: string;
  note: string;
  location: string;
  targetAudience: string;
  /** 重要マーク（★・PR-B §5.2）。盤面は既存の連絡★と同一視覚（emphasis）で描く。 */
  isHighlight: boolean;
};

/** 「その他（自由入力）」を表す select の番兵値（実 period 値ではない・UI 専用）。 */
const CUSTOM_SLOT_VALUE = "__custom__";

/**
 * 時限が「未選択（空欄）＝時限なし」を表す番兵（UI 専用）。`0` は有効時限(1..12)でも特殊スロットでもないので
 * {@link isRowPeriodComplete} が false を返す。事前生成・新規行は最初これで始まり 1限〜 を自動で入れない
 * （要望 2026-06-23）。**時限は任意**で、未選択のまま科目だけ入れれば「時限なし＝科目のみの予定」として保存・
 * 盤面表示される（{@link toScheduleItems} が period を省く・要望 2026-06-23）。番兵 0 は保存ペイロードに載せない
 * ので `ScheduleItem.period` は省略され、サーバ検証も不変（`normalizePeriod` は 0 を弾く＝0 は wire に出ない）。
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

/**
 * 行 state を保存ペイロード（ScheduleItem[]）に正規化する。dirty 判定と保存で同じ写像を使う。
 * **時限が未選択（{@link UNSELECTED_PERIOD}）/ 空の自由入力の行は `period` を省く**（時限なし＝科目のみの予定）。
 * 番兵 0 を保存ペイロードに載せず、盤面は時限ラベルを出さず科目だけを描く（要望 2026-06-23）。
 */
function toScheduleItems(rows: Row[]): ScheduleItem[] {
  return rows.map((r) =>
    // 区切り線（§5.3）: subject を任意ラベル（trim・空可）として保存。period / 詳細 / ★ は載せない
    // （validate も剥がす＝JSONB を最小に保つ）。
    r.kind === "divider"
      ? { kind: "divider" as const, subject: r.subject.trim() }
      : {
          ...(isRowPeriodComplete(r.period) ? { period: r.period } : {}),
          subject: r.subject,
          ...(r.isHighlight ? { isHighlight: true } : {}),
          ...(r.note.trim() ? { note: r.note } : {}),
          ...(r.location.trim() ? { location: r.location } : {}),
          ...(r.targetAudience.trim() ? { targetAudience: r.targetAudience } : {}),
        },
  );
}

/**
 * 事前生成した「空行」か（保存ペイロード・complete から除外する判定）。時限は既定値を持つので無視し、教員が
 * 入力しうるテキスト欄（科目 / 補足 / 場所 / 対象者）がすべて空、かつ「その他（自由入力）」の時限ラベルも空の
 * ときだけ空行とみなす。部分入力（例: 科目未入力で場所だけ入れた）は空行ではない＝従来どおり「未入力の項目が
 * あります」を出し、空の予定を保存しない。
 */
function isBlankScheduleRow(r: Row): boolean {
  // 区切り線は（ラベルが空でも）教員が意図して挿入した実体行＝空行扱いしない（保存・並べ替えの対象に残す）。
  if (r.kind === "divider") {
    return false;
  }
  const noText =
    r.subject.trim() === "" &&
    r.note.trim() === "" &&
    r.location.trim() === "" &&
    r.targetAudience.trim() === "";
  const customLabel = isCustomPeriod(r.period) && r.period.custom.trim().length > 0;
  return noText && !customLabel && !r.isHighlight;
}

/**
 * 任意項目（補足 / 場所 / 対象者 / ★重要）のいずれかに入力があるか。初期から「詳細」を開いておく行の判定
 * （入力済みを隠さない・{@link useRowDisclosure}）と、折りたたみ中の「入力あり」ドット表示の両方に使う純関数。
 */
function hasScheduleDetail(r: {
  note: string;
  location: string;
  targetAudience: string;
  isHighlight: boolean;
}): boolean {
  return (
    r.note.trim() !== "" ||
    r.location.trim() !== "" ||
    r.targetAudience.trim() !== "" ||
    r.isHighlight
  );
}

/**
 * サーバ（`validateScheduleItems`）と同じ並び規則で行をクライアント側でも安定再ソートする（§5.1・ドロップ後に
 * 見た目と保存結果を一致させる）。区切り線（divider）は位置保持＝区間ごとに slot キー昇順（安定）。時限が
 * 未確定（未選択 / 空の自由入力）の行は保存時に period を省くのと同じく「時限なし」キーに倒す。
 */
function sortRowsLikeServer(rows: Row[]): Row[] {
  return sortScheduleSegments(
    rows,
    (r) => scheduleSlotSortKey(isRowPeriodComplete(r.period) ? r.period : undefined),
    (r) => r.kind === "divider",
  );
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
    const initial: Row[] = initialItems.map((i, idx) => ({
      id: `r${idx}`,
      ...(i.kind === "divider" ? { kind: "divider" as const } : {}),
      // 時限なし（科目のみ）の保存済み行は period 省略＝undefined。select の「（時限なし）」に対応する番兵に戻す。
      period: i.period ?? UNSELECTED_PERIOD,
      subject: i.subject,
      note: i.note ?? "",
      location: i.location ?? "",
      targetAudience: i.targetAudience ?? "",
      isHighlight: i.isHighlight === true,
    }));
    // 盤面の規定枠（prefillRows）まで空行を足す。時限は**未選択（空欄）**で始める（自動で 1限〜5限 を割り当て
    // ない・要望 2026-06-23）。教員が各行を埋めるとき時限を選ぶ。prefillRows=0（scope/ops 等）は no-op で従来どおり。
    return padBlankRows(initial, prefillRows, (index) => ({
      id: `r${index}`,
      period: UNSELECTED_PERIOD,
      subject: "",
      note: "",
      location: "",
      targetAudience: "",
      isHighlight: false,
    }));
  });
  // 新規行の安定キー用カウンタ（初期行 + 事前生成の空行は r0.. を使うので、その総数から続けて衝突しない）。
  const nextId = useRef(Math.max(initialItems.length, prefillRows));
  // 行ごとの「詳細（任意項目）」開閉。**初期に値の入っている行は最初から開く**（入力済みを隠さない）。
  // 初期 id 付番（`r${idx}`）と一致させる（state 初期化と同じ index 基準）。
  const disclosure = useRowDisclosure(
    initialItems
      .map((i, idx) => ({
        id: `r${idx}`,
        has: hasScheduleDetail({
          note: i.note ?? "",
          location: i.location ?? "",
          targetAudience: i.targetAudience ?? "",
          isHighlight: i.isHighlight === true,
        }),
      }))
      .filter((x) => x.has)
      .map((x) => x.id),
  );

  // 事前生成した空行（{@link isBlankScheduleRow}）は保存ペイロード・complete から除外する。教員が触れていない
  // 空枠で自動保存をブロックせず、空の予定も保存しない（埋めた行だけが盤面・保存に反映）。部分入力行は残る。
  const filledRows = rows.filter((r) => !isBlankScheduleRow(r));
  const items = toScheduleItems(filledRows);
  const serialized = serializeForDirty(items);
  // ライブプレビュー連動: **科目が入っている行**を盤面へ通知する。時限なし（科目のみ）の行も盤面に出す
  // （要望 2026-06-23: 科目のみで表示できるように。未選択行は時限ラベルなしで描かれる）。科目未入力の
  // 半端な行（場所だけ入れた等）は盤面に出さない。**区切り線はラベルが空でも盤面に出す**（罫線そのものが
  // 表示物・§5.3）。保存ロジックとは独立（レンダー後に副作用で）。
  const previewItems = items.filter((it) => it.kind === "divider" || it.subject.trim().length > 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: serialized は items 変化のトリガ（items 直接 dep だと毎回新規参照で無限ループ）
  useEffect(() => {
    onItemsChange?.(previewItems);
  }, [serialized, onItemsChange]);
  // 埋めた行が全て有効（**科目あり**）かつ **数値時限**が重複しないなら自動保存。時限は任意＝未選択でも保存する
  // （要望 2026-06-23: 科目のみで盤面に表示できるように。時限なしの行は時限ラベルなしで盤面に出る）。
  // 未入力（科目空）/数値時限の重複があるうちは保存しない（サーバが弾く＝保存失敗の error 状態になるのを避け、揃った時点で保存）。
  // 特殊スロット（朝 / 昼休み / 放課後）は重複を許容する（例: 放課後に部活と三者面談）＝サーバ検証と整合。
  // 以前はここで全 period を一律に重複扱いしていたため、放課後を 2 つ入れると complete=false で**保存されなかった**
  // （要望: 放課後が 2 つあると反映されない、の是正 2026-06-22）。
  // 重複判定は**有効な数値時限(1..12)のみ**。未選択(0)は除外する（複数行が未選択でも重複扱いにしない）。
  const numberedPeriods = filledRows
    .filter((r) => r.kind !== "divider")
    .map((r) => r.period)
    .filter((p): p is number => typeof p === "number" && p >= 1);
  // 区切り線はラベル空でも有効（本文必須なし・§5.3）＝complete 判定から除外する。
  const complete =
    filledRows.every((r) => r.kind === "divider" || r.subject.trim().length > 0) &&
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
    const id = `r${nextId.current}`;
    nextId.current += 1;
    setRows((prev) => [
      ...prev,
      {
        id,
        period: UNSELECTED_PERIOD,
        subject: "",
        note: "",
        location: "",
        targetAudience: "",
        isHighlight: false,
      },
    ]);
  }, []);
  // 区切り線を末尾に追加（§5.3・モック準拠で行追加ボタンの脇）。ラベルは任意（空なら純粋な罫線）。
  // 位置は追加後に ⠿ D&D で動かす（divider は区間ソートで位置保持されるため自由に置ける）。
  function addDividerRow() {
    const id = `r${nextId.current}`;
    nextId.current += 1;
    setRows((prev) => [
      ...prev,
      {
        id,
        kind: "divider" as const,
        period: UNSELECTED_PERIOD,
        subject: "",
        note: "",
        location: "",
        targetAudience: "",
        isHighlight: false,
      },
    ]);
  }
  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }
  // ⠿ 並べ替え（§5.1・同一ソートキー内）: 行を from→to へ移した後、サーバと同じ slot キーで**安定再ソート**して
  // 見た目と保存結果を一致させる（別バケット＝別時限へ跨いだドロップはスナップバック＝時限順の意味論を壊さ
  // ない）。事前生成の空行はドロップ先にしない・位置も保持（resortFilledRows）。
  function moveRow(from: number, to: number) {
    setRows((prev) => {
      const dest = prev[to];
      if (!dest || isBlankScheduleRow(dest)) {
        return prev;
      }
      const moved = moveItem(prev, from, to);
      if (moved === prev) {
        return prev;
      }
      return resortFilledRows(moved, isBlankScheduleRow, sortRowsLikeServer);
    });
  }
  const rowReorder = useRowReorder(rows.length, moveRow);
  // 並べ替えハンドルは**実入力行が 2 件以上**のときだけ出す（空行には出さない・1 件では並べ替え不要）。
  const reorderable = filledRows.length > 1;

  // --- Tab 縦移動（スプレッドシート風の連続入力・共有フック {@link useGridTabNavigation}） ---
  // col: 0=時限 / 1=科目（いずれもコア＝常時表示）のみ。Tab=同 col の次行 / Shift+Tab=同 col の前行 /
  // 最終行 Tab で行追加。補足 / 場所 / 対象者は「詳細」パネルに畳んだ任意項目なので登録せず通常 Tab に委ねる
  // （開いている時だけ存在）。連絡・提出物・来校者・呼び出しと同じ共有フックに寄せた（要望 2026-06-23・重複排除）。
  const { registerCell, onCellKeyDown } = useGridTabNavigation(rows.length, addRow);

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
              <th style={thStyle} aria-label="並べ替え" />
              <th style={thStyle}>時限</th>
              <th style={thStyle}>科目</th>
              <th style={thStyle} aria-label="詳細" />
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const reorder = rowReorder(i);
              const open = disclosure.isOpen(r.id);
              const detailId = `schedule-detail-${r.id}`;
              // 区切り線行（§5.3）: 本文入力の代わりにラベル入力（任意）と ⠿・削除だけを出す（詳細なし）。
              if (r.kind === "divider") {
                return (
                  <tr
                    key={r.id}
                    {...reorder.rowProps}
                    style={{
                      ...(reorder.isDragging ? draggingRowStyle : {}),
                      ...(reorder.isOver ? dropOverRowStyle : {}),
                    }}
                  >
                    <td style={tdStyle}>
                      {reorderable ? (
                        <DragHandle reorder={reorder} label={`${i + 1} 行目を並べ替え`} />
                      ) : null}
                    </td>
                    <td colSpan={3} style={tdStyle}>
                      <span
                        aria-hidden="true"
                        style={{ color: tokens.color.muted, marginRight: "0.4rem" }}
                      >
                        ── 区切り線
                      </span>
                      <input
                        // Tab 縦移動のグリッドに穴を作らない: 時限（col0）/ 科目（col1）どちらの縦移動でも
                        // このラベル入力に着地させる（divider 行は入力がこれ 1 つ）。
                        ref={(el) => {
                          registerCell(i, 0, el);
                          registerCell(i, 1, el);
                        }}
                        value={r.subject}
                        onChange={(e) => update(i, { subject: e.target.value })}
                        onKeyDown={(e) => onCellKeyDown(e, i, 1)}
                        placeholder="ラベル（省略可）"
                        maxLength={DIVIDER_LABEL_MAX}
                        style={{ ...inputStyle, width: "12rem" }}
                        aria-label={`${i + 1} 行目の区切り線ラベル`}
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
              }
              return (
                // 安定キー `r.id`（「詳細」開閉を行に結ぶ）。主役 `<tr>` と詳細 `<tr>` の 2 行を 1 行として
                // 束ねるため Fragment に key を置く（保存は period でソート/検証＝順序は UI 状態のまま）。
                <Fragment key={r.id}>
                  {/* 主役行（時限 / 科目）。D&D / ↑↓ の対象はこの行だけ（rowProps は詳細 tr に付けない）。 */}
                  <tr
                    {...reorder.rowProps}
                    style={{
                      ...(reorder.isDragging ? draggingRowStyle : {}),
                      ...(reorder.isOver ? dropOverRowStyle : {}),
                    }}
                  >
                    <td style={tdStyle}>
                      {reorderable && !isBlankScheduleRow(r) ? (
                        <DragHandle reorder={reorder} label={`${i + 1} 行目を並べ替え`} />
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <select
                        ref={(el) => registerCell(i, 0, el)}
                        value={slotSelectValue(r.period)}
                        onChange={(e) => update(i, { period: parseSlotValue(e.target.value) })}
                        onKeyDown={(e) => onCellKeyDown(e, i, 0)}
                        style={{ ...inputStyle, width: "6rem" }}
                        aria-label={`${i + 1} 行目の時限`}
                      >
                        {/* 未選択（時限なし）。事前生成・新規行はここで始まる。時限は任意で、選ばなければ
                            時限ラベルなしの「科目のみ」の予定として盤面に出る（要望 2026-06-23）。 */}
                        <option value="">（時限なし）</option>
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
                      <RowDetailToggle
                        open={open}
                        hasValue={hasScheduleDetail(r)}
                        onToggle={() => disclosure.toggle(r.id)}
                        controlsId={detailId}
                        label={`${i + 1} 行目の詳細項目`}
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
                  {/* 詳細行（重要 / 補足 / 場所 / 対象者）。開いている時だけ描画。D&D のドロップ先にしないため
                      reorder.rowProps を付けない。 */}
                  {open ? (
                    <tr>
                      <td colSpan={5} style={{ ...tdStyle, paddingTop: 0 }}>
                        <div id={detailId} style={detailPanelStyle}>
                          {/* ★重要（§5.2・連絡の重要フラグと同作法）。盤面は emphasis（既存の連絡★と同一視覚）。 */}
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.25rem",
                              fontSize: tokens.fontSize.sm,
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={r.isHighlight}
                              onChange={(e) => update(i, { isHighlight: e.target.checked })}
                              aria-label={`${i + 1} 行目の重要マーク`}
                            />
                            重要
                          </label>
                          <DetailField label="補足">
                            <input
                              value={r.note}
                              onChange={(e) => update(i, { note: e.target.value })}
                              placeholder="(任意)"
                              style={{ ...inputStyle, width: "100%" }}
                              aria-label={`${i + 1} 行目の補足`}
                            />
                          </DetailField>
                          <DetailField label="場所">
                            <input
                              value={r.location}
                              onChange={(e) => update(i, { location: e.target.value })}
                              placeholder="(任意) 体育館 等"
                              style={{ ...inputStyle, width: "100%" }}
                              aria-label={`${i + 1} 行目の場所`}
                            />
                          </DetailField>
                          <DetailField label="対象者">
                            <input
                              value={r.targetAudience}
                              onChange={(e) => update(i, { targetAudience: e.target.value })}
                              placeholder="(任意) 3年生 等"
                              style={{ ...inputStyle, width: "100%" }}
                              aria-label={`${i + 1} 行目の対象者`}
                            />
                          </DetailField>
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
          予定を追加
        </button>
        {/* 区切り線（§5.3・行追加ボタンの脇）: ダッシュ行ハックの正規化。位置は ⠿ で動かす。 */}
        <button type="button" onClick={addDividerRow} style={secondaryBtnStyle}>
          ＋区切り線
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </div>
  );
}
