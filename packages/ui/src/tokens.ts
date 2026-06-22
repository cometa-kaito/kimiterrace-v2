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
  /** 白サーフェス（カード/ボタン地）。インライン style で生 "#fff" を散らさないための単一ソース。 */
  surface: "#ffffff",
  /** UI アクセント（明るいオレンジ #ea580c・2026-06-06 ユーザー指定で旧 #c2410c から明色化。
   *  白文字は約 3.6:1 = 非テキスト UI 3:1 のみ充足／通常テキスト 4.5:1 は未達、hover #c2410c は AA 充足）。
   *  グラデはロゴ画像のみ・2026-06-05 方針。globals.css --brand-primary と一致させること。 */
  primary: "#ea580c",
  primaryHover: "#c2410c",
  /** ブランドブルー（LP --primary #2B4ACB と同値・UIUX-00 共通トークン）。見出し/リンク/強調用。
   *  白背景上のテキスト 4.5:1 を充足。淡い blue #6fa8c7 は副次色として残す（置換ではなく追加）。
   *  globals.css --brand-blue-strong と一致させること。 */
  blueStrong: "#2b4acb",

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
