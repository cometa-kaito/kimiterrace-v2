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
