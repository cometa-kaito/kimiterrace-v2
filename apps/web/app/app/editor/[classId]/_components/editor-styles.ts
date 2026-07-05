import { tokens } from "@kimiterrace/ui";

/**
 * エディタ各セクション (#48-H Schedule / #48-I Notice / Assignment) 共通のインラインスタイル。
 * ScheduleEditor.tsx が定義していた値をセクション間で再利用するため切り出した (見た目の単一ソース)。
 * 色は `@kimiterrace/ui` の tokens を参照する（UIUX-02: ハードコード hex の整流）。
 */

const { color, fontSize, radius } = tokens;

export const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
};
export const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: fontSize.sm,
  color: color.muted,
  padding: "0.25rem 0.4rem",
};
export const tdStyle: React.CSSProperties = { padding: "0.25rem 0.4rem", verticalAlign: "top" };
// 保存はこの画面の主アクション。ブランドのアクション色（オレンジ）に揃え、タップ領域 44px を確保する
// （白文字×#ea580c は非テキスト UI 3:1 充足・.brand-btn と同一の既存判断）。
export const primaryBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.45rem 1.1rem",
  background: color.primary,
  color: color.surface,
  border: "none",
  borderRadius: radius.sm,
  cursor: "pointer",
  fontWeight: 600,
};
export const secondaryBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.45rem 1.1rem",
  background: color.surface,
  color: color.ink,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  cursor: "pointer",
};
// 三次アクション（＋区切り線 等・#4 ボタン階層）。主アクション（○○を追加＝primary 塗り）と差をつけるため、
// 枠・地色を持たない静かなテキストボタンにする。タップ領域 44px は維持。
export const subtleBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.45rem 0.6rem",
  background: "transparent",
  color: color.muted,
  border: "none",
  borderRadius: radius.sm,
  cursor: "pointer",
  fontSize: fontSize.sm,
};
// 行削除ボタン（#2 ゴースト化）。5 行反復で赤枠ボタンが並ぶと chrome が content を上回るため、枠・地色を
// 外した控えめなゴーストにする。**色（既定 muted → hover/focus で危険色）はグローバルクラス `.kt-row-delete`
// が持つ**（インライン color は :hover を上書きできないため。className と併用する前提）。タッチ端末では hover が
// 無いので「常時 muted で見える」＝発見性を保ちつつ、hover/focus で赤くして破壊操作だと分かるようにする。
export const removeBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.4rem",
  background: "transparent",
  border: "none",
  borderRadius: radius.sm,
  cursor: "pointer",
  // 隣の「詳細」トグル（sm）より一段小さくして従属させる（敵対的批評 R2: 削除が詳細と同じ視覚的重みで競う）。
  // 色（赤）で破壊操作と分かり、サイズで主役（本文）より下位だと分かる。
  fontSize: fontSize.xs,
  // 「削除」が幅不足で 2 行に折返すのを防ぐ（狭い列でも 1 行表示）。
  whiteSpace: "nowrap",
};

/**
 * #243 (②UI-UX): 表（予定 / 提出物）をスマホでも崩さず横スクロールで読めるようにするラッパ。
 * 表自体は `tableStyle` で min-width を持たせ、狭幅では本ラッパが横スクロールを出す（列が潰れない）。
 */
export const tableWrapStyle: React.CSSProperties = {
  overflowX: "auto",
  WebkitOverflowScrolling: "touch",
};
export const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  minWidth: "30rem",
};

/** 保存ボタン行（ボタン + 保存状態テキストを横並び、狭幅で折返し）。 */
export const saveBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "center",
  flexWrap: "wrap",
};
/** 「未保存の変更があります」（注意色）。 */
export const dirtyTextStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  fontWeight: 600,
  color: color.warningFg,
};
/** 「保存済み」（成功色）。 */
export const savedTextStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  color: color.successFg,
};
/** 「保存中…」（控えめ）。 */
export const savingTextStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  color: color.muted,
};
/** 「保存に失敗」（危険色）。 */
export const errorTextStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  fontWeight: 600,
  color: color.dangerFg,
};
/** 無効化された保存ボタン（未変更時）。 */
export const primaryBtnDisabledStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: color.muted,
  cursor: "not-allowed",
};

/* ------------------------------------------------------------------ *
 *  並べ替え（ポインタ D&D / ↑↓ キー）— 「配列順 = サイネージ表示順」のセクション用
 *
 *  学校管理 #1116 の grip（⠿）と同じ視覚言語。色だけに頼らず、ドラッグ中は半透明・ドロップ先は左辺に
 *  ブランド色の差し込み線でヒントする。操作はマウス/タッチ/ペン共通のポインタ D&D ＋ フォーカス時の ↑↓ キー
 *  （要望 2026-06-23: 上下ボタンは廃止）。実装は useRowReorder / DragHandle。
 * ------------------------------------------------------------------ */

/**
 * ドラッグハンドル（グリップ ⠿）。実体は `<button>`（a11y: 操作要素は意味づけのある要素にする）なので、
 * ボタン既定の地色/枠を消して素のグリップ見た目にする。掴めるカーソル＋控えめ色、タッチで掴めるよう
 * `touch-action: none`（スクロールに奪われない）。
 */
export const gripStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "grab",
  // 掴めることに気づけるよう muted より濃い neutralFg にする（敵対的批評: ハンドルが極薄で発見不能）。
  color: color.neutralFg,
  fontSize: fontSize.md,
  lineHeight: 1,
  padding: "0.25rem 0.15rem",
  userSelect: "none",
  touchAction: "none",
};
/** ドラッグ中の行（半透明＝掴んでいることを示す）。 */
export const draggingRowStyle: React.CSSProperties = {
  opacity: 0.5,
};
/**
 * 事前生成した空行の de-emphasis（#3「空欄が埋まって見える」→ 記入済みだけ濃く）。盤面の規定枠ぶん並ぶ空行を
 * 薄くして、実際に記入済みの行と視覚的な濃淡差をつける（真の空状態＝これから埋める枠だと分かる）。入力すると
 * 行が「空でない」と判定され本スタイルは外れて濃くなる（{@link isBlankScheduleRow} 等）。opacity なので操作は
 * 引き続き可能（disabled ではない）。
 */
export const blankRowStyle: React.CSSProperties = {
  // 記入済みの行を主役にし、空の予備行はさらに後退させる（敵対的批評 R2: 空行が実入力と同じ強さに見える）。
  // 削除/詳細の chrome も畳んでいるので、この薄さでも「これから埋める空スロット」と読める。薄すぎて「無効」に
  // 見えない下限として 0.6（プレースホルダは元々ヒントで AA 対象外）。
  opacity: 0.6,
};
/** ドロップ先候補の行（左辺にブランド色の差し込み線で「ここに入る」を示す）。 */
export const dropOverRowStyle: React.CSSProperties = {
  boxShadow: `inset 3px 0 0 0 ${color.primary}`,
  borderRadius: radius.sm,
};
/**
 * 空状態の罫線（点線）プレースホルダ（来校者一覧 / 生徒呼び出し）。LEDGER v2-ed-uo6: 装飾枠ではなく
 * 「ここにデータが入る」を点線の行で示唆する。空テーブルのヘッダだけが浮く違和感を解消する。
 */
export const emptyPlaceholderStyle: React.CSSProperties = {
  padding: "0.75rem 0.6rem",
  border: `1px dashed ${color.border}`,
  borderRadius: radius.sm,
  color: color.muted,
  fontSize: fontSize.sm,
  textAlign: "center",
};

/* ------------------------------------------------------------------ *
 *  行ごとの「詳細（任意項目）」畳み込み（引き算レーン・{@link RowDetails}）
 *
 *  主役（必須）だけを常時表示し、任意項目は行ごとの「詳細」トグルで開閉する。来校者 6 列・予定 5 列等の
 *  横潰れを解消し、スマホでも主役だけで読み書きできる。値の入っている行は初期から開く（入力済みを隠さない）。
 * ------------------------------------------------------------------ */

/** 「詳細」開閉トグル（行ごと）。素のテキストボタン・控えめ色・1 行表示。 */
export const detailToggleStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  background: "transparent",
  border: "none",
  color: color.muted,
  cursor: "pointer",
  fontSize: fontSize.sm,
  whiteSpace: "nowrap",
  padding: "0.25rem 0.3rem",
};
/** 折りたたみ中でも任意項目に入力がある合図（ブランド色の小さな点）。色だけに頼らず SR 文言も添える（NFR05）。 */
export const detailDotStyle: React.CSSProperties = {
  width: "0.5rem",
  height: "0.5rem",
  borderRadius: radius.pill,
  background: color.primary,
};
/** 行の任意項目を入れる詳細パネル（主役の下にぶら下がる副次領域・横並びで折返し）。
 *  #1: 枠線は外し「面（bgSoft）」だけで主役の下位であることを示す（box-in-box の視覚ノイズを減らす）。 */
export const detailPanelStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.6rem 0.9rem",
  padding: "0.6rem 0.75rem",
  borderRadius: radius.sm,
  background: color.bgSoft,
};
/** 詳細パネル内の 1 項目（ラベルを上に小さく置き、その下に入力を縦積み）。 */
export const detailFieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  fontSize: fontSize.xs,
  color: color.muted,
};
/** SR 専用テキスト（視覚的に隠す）。`.admin-main` の positioned 文脈内で使う（幽霊スクロール対策・#1153）。 */
export const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};
