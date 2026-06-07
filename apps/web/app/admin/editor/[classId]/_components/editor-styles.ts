/**
 * エディタ各セクション (#48-H Schedule / #48-I Notice / Assignment) 共通のインラインスタイル。
 * ScheduleEditor.tsx が定義していた値をセクション間で再利用するため切り出した (見た目の単一ソース)。
 */

export const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
};
export const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.85rem",
  color: "#6b7280",
  padding: "0.25rem 0.4rem",
};
export const tdStyle: React.CSSProperties = { padding: "0.25rem 0.4rem", verticalAlign: "top" };
export const primaryBtnStyle: React.CSSProperties = {
  padding: "0.45rem 1.1rem",
  background: "#1f2937",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};
export const secondaryBtnStyle: React.CSSProperties = {
  padding: "0.45rem 1.1rem",
  background: "#fff",
  color: "#1f2937",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  cursor: "pointer",
};
export const removeBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.6rem",
  background: "transparent",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.85rem",
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
  fontSize: "0.82rem",
  fontWeight: 600,
  color: "#b45309",
};
/** 「保存済み」（成功色）。 */
export const savedTextStyle: React.CSSProperties = {
  fontSize: "0.82rem",
  color: "#166534",
};
/** 無効化された保存ボタン（未変更時）。 */
export const primaryBtnDisabledStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: "#9ca3af",
  cursor: "not-allowed",
};
