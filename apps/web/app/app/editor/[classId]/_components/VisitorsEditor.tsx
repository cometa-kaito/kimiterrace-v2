"use client";

import { serializeForDirty, useAutoSaveSection } from "@/lib/editor/editor-save-state";
import { setVisitorsAction } from "@/lib/editor/visitors-actions";
import { validateVisitorItems } from "@/lib/editor/visitors-core";
import { padBlankRows } from "@/lib/editor/prefill-rows";
import type { ClassVisitor } from "@kimiterrace/db";
import { Fragment, useRef, useState } from "react";
import { AutoSaveStatusText } from "./AutoSaveStatusText";
import { DragHandle } from "./DragHandle";
import { FieldLegend, RequiredMark } from "./FieldMarks";
import {
  detailPanelStyle,
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
import { DetailField, RowDetailToggle, useRowDisclosure } from "./RowDetails";
import { useGridTabNavigation } from "./useGridTabNavigation";
import { moveItem, useRowReorder } from "./useRowReorder";

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
 * **表示順の変更（要望 2026-06-22 → 2026-06-23）**: 来校者は既定では盤面で時刻順に並ぶが、教員が任意の順に
 * 並べ替えたいケースがあるため、行を**ドラッグ&ドロップ**で並べ替えられるようにする（{@link useRowReorder} /
 * {@link DragHandle}）。並べ替えはマウス/タッチ/ペン共通のポインタ D&D で、タブレットでも掴んで動かせる。
 * フォーカス時の ↑↓ キーでも動かせる（要望 2026-06-23: 上下ボタンは廃止しドラッグ主体・キーボード経路は残す）。
 * 並べ替え後の配列順は既存の自動保存経路でそのまま保存され、サーバが各行の位置を `sort_order` に採番する
 * （migration 0034）。読み取りは `sort_order` 昇順優先（同順位は時刻→氏名）。
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
 * 事前生成した「空行」か（6 欄すべて空）。全欄空の行は保存ペイロード・complete から除外し、並べ替えハンドルも
 * 出さない（教員が触れていない空枠で保存・並べ替えをさせない）。氏名未入力で時刻だけ等の**部分入力**行は空行では
 * ない＝従来どおり氏名必須エラーで保存待ちにし、入力漏れに気づける。
 */
function isBlankVisitorRow(r: Row): boolean {
  return (
    r.scheduledTime.trim() === "" &&
    r.visitorName.trim() === "" &&
    r.affiliation.trim() === "" &&
    r.purpose.trim() === "" &&
    r.host.trim() === "" &&
    r.note.trim() === ""
  );
}

/**
 * 任意項目（所属 / 用件 / 対応者 / 備考）のいずれかに入力があるか。初期から「詳細」を開いておく行の判定
 * （入力済みを隠さない・{@link useRowDisclosure}）と、折りたたみ中の「入力あり」ドット表示の両方に使う純関数。
 */
function hasVisitorDetail(r: {
  affiliation: string;
  purpose: string;
  host: string;
  note: string;
}): boolean {
  return (
    r.affiliation.trim() !== "" ||
    r.purpose.trim() !== "" ||
    r.host.trim() !== "" ||
    r.note.trim() !== ""
  );
}

export function VisitorsEditor({
  classId,
  date,
  initialItems,
  prefillRows = 0,
}: {
  classId: string;
  date: string;
  initialItems: ClassVisitor[];
  /**
   * 盤面の規定枠ぶん**空行を事前生成**する数（{@link blockRowCapacity}）。既定 0（事前生成せず従来挙動）。
   * 空行（全欄空）は保存ペイロード・自動保存判定・並べ替えハンドルから除外され、埋めなくても保存をブロックしない。
   */
  prefillRows?: number;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    padBlankRows(
      initialItems.map((i, idx) => ({
        id: `r${idx}`,
        scheduledTime: i.scheduledTime ?? "",
        visitorName: i.visitorName,
        affiliation: i.affiliation ?? "",
        purpose: i.purpose ?? "",
        host: i.host ?? "",
        note: i.note ?? "",
      })),
      prefillRows,
      (index) => ({
        id: `r${index}`,
        scheduledTime: "",
        visitorName: "",
        affiliation: "",
        purpose: "",
        host: "",
        note: "",
      }),
    ),
  );
  // 新規行の安定キー用カウンタ（初期行 + 事前生成の空行は r0.. を使うので、その総数から続けて衝突しない）。
  const nextId = useRef(Math.max(initialItems.length, prefillRows));
  // 行ごとの「詳細（任意項目）」開閉。**初期に値の入っている行は最初から開く**（入力済みを隠さない）。
  // 初期 id 付番（`r${idx}`）と一致させる（state 初期化と同じ index 基準）。
  const disclosure = useRowDisclosure(
    initialItems
      .map((i, idx) => ({
        id: `r${idx}`,
        has: hasVisitorDetail({
          affiliation: i.affiliation ?? "",
          purpose: i.purpose ?? "",
          host: i.host ?? "",
          note: i.note ?? "",
        }),
      }))
      .filter((x) => x.has)
      .map((x) => x.id),
  );

  // 事前生成した空行（全欄空）は保存ペイロード・complete・並べ替え対象から除外する（空枠で保存をブロックせず、
  // 空の来校者を保存しない／空行を掴ませない）。教員が氏名等を入れた行だけが盤面・保存に反映される。
  const filledRows = rows.filter((r) => !isBlankVisitorRow(r));
  // 並べ替えハンドルは**実入力行が 2 件以上**のときだけ各実入力行に出す（空行には出さない・1 件では並べ替え不要）。
  const reorderable = filledRows.length > 1;
  const items = toItems(filledRows);
  const serialized = serializeForDirty(items);
  // 埋めた行が全て有効（氏名必須・時刻は指定時のみ HH:MM）なら自動保存する。判定はサーバと同じ純関数
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
  // **事前生成の空行をドロップ先にしない**: ハンドルは実入力行にしか出ない（= from は実入力行）が、`to` は
  // ↑↓ キー / ポインタのヒットテストで末尾の空行スロットを指しうる。実入力行を空行スロットへ落とすと実入力
  // 行どうしの間に空行が挟まり「行間が空いて盤面が崩れて見える」（順序は実入力行のみで保存され無害だが見た目
  // バグ）。行き先が空行なら no-op（参照同一で返し再描画も増やさない・useRowReorder の範囲外チェックと同作法）。
  function moveRow(from: number, to: number) {
    setRows((prev) => {
      const dest = prev[to];
      if (!dest || isBlankVisitorRow(dest)) {
        return prev;
      }
      return moveItem(prev, from, to);
    });
  }
  const rowReorder = useRowReorder(rows.length, moveRow);
  // Tab 縦移動（スプレッドシート風・共有フック {@link useGridTabNavigation}）。col: 0=氏名（コア＝常時表示）のみ。
  // 所属 / 用件 / 対応者 / 備考は「詳細」パネルに畳んだ任意項目なので登録せず通常 Tab に委ねる（開いている時だけ存在）。
  // 時刻は native time ピッカー（内部セグメント間 Tab を残す）なので登録せず既定動作のまま。
  const { registerCell, onCellKeyDown } = useGridTabNavigation(rows.length, addRow);

  return (
    <section style={{ display: "grid", gap: "0.75rem", maxWidth: "880px" }}>
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
              <th style={thStyle} aria-label="詳細" />
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...tdStyle, padding: 0 }}>
                  <div style={emptyPlaceholderStyle}>
                    まだ来校者がありません。「来校者を追加」から入力します。
                  </div>
                </td>
              </tr>
            ) : null}
            {rows.map((r, i) => {
              const reorder = rowReorder(i);
              const open = disclosure.isOpen(r.id);
              const detailId = `visitor-detail-${r.id}`;
              return (
                // 安定キー `r.id` で並べ替え時も行の同一性を保つ（NoticeEditor と同方式）。主役 `<tr>` と
                // 詳細 `<tr>` の 2 行を 1 行として束ねるため Fragment に key を置く。
                <Fragment key={r.id}>
                  {/* 主役行（時刻 / 氏名）。D&D / ↑↓ の対象はこの行だけ（reorder.rowProps は詳細 tr に付けない）。 */}
                  <tr
                    {...reorder.rowProps}
                    style={{
                      ...(reorder.isDragging ? draggingRowStyle : {}),
                      ...(reorder.isOver ? dropOverRowStyle : {}),
                    }}
                  >
                    <td style={tdStyle}>
                      {reorderable && !isBlankVisitorRow(r) ? (
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
                        ref={(el) => registerCell(i, 0, el)}
                        value={r.visitorName}
                        onChange={(e) => update(i, { visitorName: e.target.value })}
                        onKeyDown={(e) => onCellKeyDown(e, i, 0)}
                        placeholder="氏名"
                        style={{ ...inputStyle, width: "100%" }}
                        aria-label={`${i + 1} 行目の氏名`}
                      />
                    </td>
                    <td style={tdStyle}>
                      <RowDetailToggle
                        open={open}
                        hasValue={hasVisitorDetail(r)}
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
                  {/* 詳細行（所属 / 用件 / 対応者 / 備考）。開いている時だけ描画。D&D のドロップ先にしないため
                      reorder.rowProps を付けない（data-reorder-index を持たせない）。 */}
                  {open ? (
                    <tr>
                      <td colSpan={5} style={{ ...tdStyle, paddingTop: 0 }}>
                        <div id={detailId} style={detailPanelStyle}>
                          <DetailField label="所属">
                            <input
                              value={r.affiliation}
                              onChange={(e) => update(i, { affiliation: e.target.value })}
                              placeholder="(任意) 所属"
                              style={{ ...inputStyle, width: "100%" }}
                              aria-label={`${i + 1} 行目の所属`}
                            />
                          </DetailField>
                          <DetailField label="用件">
                            <input
                              value={r.purpose}
                              onChange={(e) => update(i, { purpose: e.target.value })}
                              placeholder="(任意) 用件"
                              style={{ ...inputStyle, width: "100%" }}
                              aria-label={`${i + 1} 行目の用件`}
                            />
                          </DetailField>
                          <DetailField label="対応者">
                            <input
                              value={r.host}
                              onChange={(e) => update(i, { host: e.target.value })}
                              placeholder="(任意) 対応者"
                              style={{ ...inputStyle, width: "100%" }}
                              aria-label={`${i + 1} 行目の対応者`}
                            />
                          </DetailField>
                          <DetailField label="備考">
                            <input
                              value={r.note}
                              onChange={(e) => update(i, { note: e.target.value })}
                              placeholder="(任意) 備考"
                              style={{ ...inputStyle, width: "100%" }}
                              aria-label={`${i + 1} 行目の備考`}
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
          来校者を追加
        </button>
        <AutoSaveStatusText status={auto.status} error={auto.error} />
      </div>
    </section>
  );
}
