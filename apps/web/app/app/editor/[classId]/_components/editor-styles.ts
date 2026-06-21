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

/** セクション補足の注記（控えめ・トークン化。生 hex を直書きしない＝design-ui 規律）。 */
export const noteTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.xs,
  color: color.muted,
};
/** 保存結果メッセージ（成功 / 失敗）。色はトークン参照（NFR05: テキストも併記される）。 */
export function messageStyle(ok: boolean): React.CSSProperties {
  return { display: "block", fontSize: fontSize.sm, color: ok ? color.successFg : color.dangerFg };
}
/** 必須項目マーク（列ヘッダー / ラベルに添える）。色だけに依存しない（「必須」テキストと併記）。 */
export const requiredMarkStyle: React.CSSProperties = {
  marginLeft: "0.25rem",
  fontSize: fontSize.xs,
  fontWeight: 700,
  color: color.dangerFg,
};
/** 任意項目マーク（控えめ）。必須との対比で「任意」を明示する。 */
export const optionalMarkStyle: React.CSSProperties = {
  marginLeft: "0.25rem",
  fontSize: fontSize.xs,
  fontWeight: 400,
  color: color.muted,
};
/** フォーム冒頭の必須/任意の凡例（控えめ）。 */
export const legendTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.xs,
  color: color.muted,
};
/**
 * 空状態の罫線プレースホルダ行（来校者 / 呼び出しが 0 件のとき）。装飾枠ではなく**点線の枠**で「ここに
 * 行が入る」投入位置を示唆する（finding⑥: 装飾枠を外しフラットに・空状態は罫線で示す）。色だけに頼らず
 * テキスト（「『◯◯を追加』で行を追加します」）を併記する。
 */
export const emptyPlaceholderRowStyle: React.CSSProperties = {
  padding: "0.75rem 0.6rem",
  textAlign: "center",
  fontSize: fontSize.sm,
  color: color.muted,
  border: `1px dashed ${color.border}`,
  borderRadius: radius.sm,
};
