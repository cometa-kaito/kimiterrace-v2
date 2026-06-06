/**
 * デザイントークン（単一ソース）。
 *
 * これまで各ページが 16 進カラーや余白を**インライン style にハードコード**していたため、ブランド
 * 変更時に全ページを grep する必要があった。本モジュールは `apps/web/app/globals.css` の
 * `--brand-*` CSS 変数と同じ値を **TypeScript 定数**として公開し、インライン style 主体の既存
 * コードからも型付きで参照できる橋渡しにする（CSS を import できない Server Component でも使える）。
 *
 * 値は globals.css の `:root` と一致させること（CSS 変数＝サイネージ等の className 経路、本定数＝
 * インライン style 経路、どちらも同じブランド値を指す）。
 */

/** ブランド/ステータスのカラーパレット。status 系は「色＋テキスト」前提（NFR05、色のみに依存しない）。 */
export const color = {
  // ブランド基調（globals.css --brand-* と一致）。
  orange: "#e0823c",
  blue: "#6fa8c7",
  ink: "#1f2937",
  muted: "#6b7280",
  border: "#e5e7eb",
  bgSoft: "#f7f8fa",
  /** UI アクセント（白文字で WCAG AA を満たす深いオレンジ。グラデはロゴ画像のみ・2026-06-05 方針）。 */
  primary: "#c2410c",
  primaryHover: "#9a3412",

  // ステータストーン（薄背景 / 文字 / 枠）。StatusBadge・各種バナーで共有。
  neutralBg: "#f3f4f6",
  neutralFg: "#374151",
  neutralBorder: "#e5e7eb",
  successBg: "#ecfdf5",
  successFg: "#047857",
  successBorder: "#a7f3d0",
  warningBg: "#fffbeb",
  warningFg: "#b45309",
  warningBorder: "#fde68a",
  dangerBg: "#fef2f2",
  dangerFg: "#b91c1c",
  dangerBorder: "#fecaca",
  infoBg: "#eff6ff",
  infoFg: "#1d4ed8",
  infoBorder: "#bfdbfe",
} as const;

/** 角丸。pill は完全な丸（バッジ）。 */
export const radius = {
  sm: "0.4rem",
  md: "0.6rem",
  lg: "1rem",
  pill: "999px",
} as const;

/** 余白スケール（rem）。 */
export const space = {
  xs: "0.25rem",
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1.25rem",
  xl: "2rem",
} as const;

/** フォントサイズスケール（rem）。 */
export const fontSize = {
  xs: "0.78rem",
  sm: "0.85rem",
  md: "0.95rem",
  lg: "1.15rem",
  xl: "1.5rem",
} as const;
