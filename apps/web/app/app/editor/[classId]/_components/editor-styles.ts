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
  color: "#fff",
  border: "none",
  borderRadius: radius.sm,
  cursor: "pointer",
  fontWeight: 600,
};
export const secondaryBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.45rem 1.1rem",
  background: "#fff",
  color: color.ink,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  cursor: "pointer",
};
export const removeBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.6rem",
  background: "transparent",
  color: color.dangerFg,
  border: `1px solid ${color.dangerBorder}`,
  borderRadius: radius.sm,
  cursor: "pointer",
  fontSize: fontSize.sm,
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
