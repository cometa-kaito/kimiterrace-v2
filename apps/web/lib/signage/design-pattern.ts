/**
 * クライアントセーフなサイネージ・デザインパターンの定義・型・URL ヘルパ（学校別 / 端末別デザイン）。
 *
 * **postgres を引き込まない**こと（"use client" な TV 設定編集フォームと Server の両方から import するため、
 * DB 依存を持たない純粋モジュールに保つ。#148 の client/server バンドル分離の踏襲。barrel
 * `@kimiterrace/db` を runtime import するとフォームの next build が落ちる）。DB 依存（school_configs の
 * 学校レベル既定読み取り）は server 専用の `signage-design.ts` 側に置く。
 *
 * ## 端末別デザインの保持方法（スキーマ非変更）
 * パターンは `tv_devices.signage_url` の `?design=patternN` クエリに載せる（**専用列を足さない**＝
 * `tv_devices` スキーマ/クエリを触らずに端末別切替を実現する）。TV 端末は config ポーリングで得た
 * `signage_url` をそのまま開き、サイネージページが `?design` を読んで盤面コンポーネントを dispatch する。
 * **既定 `pattern1` はパラメータ無し**で表す（後方互換: `?design` の無い既存 URL は自動的に pattern1）。
 * 管理 UI（TV 設定編集）はドロップダウンで選び、保存時に本ヘルパで URL へ合成する。未知値・パース不能は
 * すべて既定にフォールバックする（fail-soft、盤面を壊さない）。将来パターン追加は本 union と
 * `SignageClient` の dispatch に case を足すだけで拡張できる。
 */

export const SIGNAGE_DESIGN_PATTERNS = [
  "pattern1",
  "pattern2",
  "pattern3",
  "pattern4",
  "pattern5",
] as const;

export type SignageDesignPattern = (typeof SIGNAGE_DESIGN_PATTERNS)[number];

/** 未設定・不正値・未知パターン時の既定（v1 レイアウト）。 */
export const DEFAULT_SIGNAGE_DESIGN_PATTERN: SignageDesignPattern = "pattern1";

/** 管理 UI（TV 設定編集のドロップダウン）に出すパターン名ラベル。 */
export const SIGNAGE_DESIGN_PATTERN_LABELS: Record<SignageDesignPattern, string> = {
  pattern1: "パターン1（標準・v1レイアウト）",
  pattern2: "パターン2（予定 / 来校者 / 呼び出し / センサ / 天気 / 鉄道）",
  pattern3: "パターン3（廊下設置・pattern2 から時事ニュースを除く）",
  pattern4: "パターン4（教員入力最小・天気/ニュース主役・連絡のみ編集）",
  pattern5: "パターン5（掲示板型・お知らせ主役）",
};

/**
 * サイネージ「予定」セクションで表示する**平日の日数（= 予定グリッドの列数）**をパターン別に持つ単一ソース。
 *
 * 🔧 **日数を変えるのはここ 1 か所**。値を書き換えるだけで:
 *  - データ取得日数（`signage-display.ts` が `signageScheduleDates(date, n)` に渡す日数）と
 *  - 盤面の列数（`SignageBoardView` が描画した `days.length` を CSS 変数 `--schedule-cols` /
 *    `--p3-schedule-cols` で grid に流すため、列数はデータに自動追従する）
 * が**同時に**追従する。以前は `rotation.ts` の単一値（全パターン共通=5）で、pattern1/2 まで 5 日に
 * なっていた（#1127「盤面5日表示」の副作用）。本マップでパターン別に分離し直す。
 *
 * 既定値:
 *  - `pattern1` / `pattern2`: 標準・掲示盤面は「今後 3 平日」。
 *  - `pattern3`（廊下版）: 遠目最適化で「平日 5 日」（2026-06-22 ユーザー確定）。
 *  - `pattern4`（教員入力最小）: 予定セクションを描画しないため `0`（= 取得もしない）。
 *  - `pattern5`（掲示板型）: 「今日の予定」1 列のみ（多日グリッドを出さない・editor-restructure-bulletin §6.1）。
 *
 * 土日はスキップして「平日 n 日」を出す（`signageScheduleDates`）。値を増やすと列が細くなるので、
 * 盤面の可読性（特に廊下版の遠目）とコマのはみ出しを実機で確認すること。
 */
export const SIGNAGE_SCHEDULE_DAY_COUNT: Record<SignageDesignPattern, number> = {
  pattern1: 3,
  pattern2: 3,
  pattern3: 5,
  pattern4: 0,
  pattern5: 1,
};

/** パターンの予定表示日数（= 予定グリッドの列数）。未知値は既定 pattern1 の日数に倒す（fail-soft）。 */
export function signageScheduleDayCount(pattern: SignageDesignPattern): number {
  return SIGNAGE_SCHEDULE_DAY_COUNT[pattern] ?? SIGNAGE_SCHEDULE_DAY_COUNT.pattern1;
}

/** signage_url / サイネージ URL に載せるデザイン指定クエリのキー。 */
export const SIGNAGE_DESIGN_QUERY_KEY = "design";

/** 文字列が既知のパターンか型ガードする。 */
export function isSignageDesignPattern(value: unknown): value is SignageDesignPattern {
  return (
    typeof value === "string" && (SIGNAGE_DESIGN_PATTERNS as readonly string[]).includes(value)
  );
}

/**
 * `display_settings` config の `value`（JSONB, opaque）から `signageDesign` を **defensive に**取り出す
 * （学校レベルの既定デザイン）。形が想定外・キー欠落・未知パターンはいずれも既定 `pattern1` に倒す
 * （fail-soft、盤面を壊さない）。
 */
export function parseSignageDesignPattern(configValue: unknown): SignageDesignPattern {
  if (configValue && typeof configValue === "object" && !Array.isArray(configValue)) {
    const v = (configValue as Record<string, unknown>).signageDesign;
    if (isSignageDesignPattern(v)) {
      return v;
    }
  }
  return DEFAULT_SIGNAGE_DESIGN_PATTERN;
}

/** 文字列を絶対 URL としてパースする（相対・空・不正は null。fail-soft）。 */
function tryParseUrl(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * サイネージ URL の `?design=` から端末別デザインパターンを取り出す。未指定・未知・パース不能は `null`
 * （= 呼び出し側が学校レベル既定 / `pattern1` に倒す）。
 */
export function getDesignPatternFromUrl(
  url: string | null | undefined,
): SignageDesignPattern | null {
  const parsed = tryParseUrl(url);
  if (!parsed) return null;
  const v = parsed.searchParams.get(SIGNAGE_DESIGN_QUERY_KEY);
  return isSignageDesignPattern(v) ? v : null;
}

/**
 * クラス（端末）の代表サイネージ URL と学校レベル既定から、**実効デザインパターン**を解決する純関数
 * （client-safe・DB 非依存）。優先順位は **端末別 `?design` > 学校レベル既定 > `pattern1`**（既定は呼び出し側が
 * 渡す `schoolDefault` が既に `pattern1` に倒れている前提）。`buildSignagePayloadForClass` のサーバ側解決
 * （`isSignageDesignPattern(designParam) ? designParam : 学校既定`）と**同じ優先順位**をエディタ側でも 1 関数で
 * 共有し、実機 TV と「モニタの壁」/ クラスエディタのプレビューが一致するようにする（ドリフト防止）。
 *
 * `url` が `?design` を持たない / パース不能なら `schoolDefault` を返す（fail-soft、盤面を壊さない）。
 */
export function resolveDesignPattern(
  url: string | null | undefined,
  schoolDefault: SignageDesignPattern,
): SignageDesignPattern {
  return getDesignPatternFromUrl(url) ?? schoolDefault;
}

/**
 * サイネージ URL から `design` クエリを取り除いた「素の URL」を返す（編集フォームの URL 欄表示用＝
 * パターン選択はドロップダウンが担い、URL 欄は design を持たない base を見せる）。`design` が無い / パース
 * 不能なら原文をそのまま返す（正規化による予期せぬ書き換えを避ける）。
 */
export function stripDesignParam(url: string | null | undefined): string {
  if (!url) return "";
  const parsed = tryParseUrl(url);
  if (!parsed) return url;
  if (!parsed.searchParams.has(SIGNAGE_DESIGN_QUERY_KEY)) return url;
  parsed.searchParams.delete(SIGNAGE_DESIGN_QUERY_KEY);
  return parsed.toString();
}

/**
 * 素の URL にデザインパターンを合成する（保存時）。既定 `pattern1` は **パラメータを付けない**（URL を
 * 汚さない・後方互換）。`pattern2` 以降は `?design=patternN` を設定する（既存の design 値は置換）。
 * パース不能（相対・空）はそのまま返す（fail-soft。呼出側は事前に http(s) 絶対 URL を検証済み）。
 */
export function applyDesignPatternToUrl(url: string, pattern: SignageDesignPattern): string {
  const parsed = tryParseUrl(url);
  if (!parsed) return url;
  const had = parsed.searchParams.has(SIGNAGE_DESIGN_QUERY_KEY);
  parsed.searchParams.delete(SIGNAGE_DESIGN_QUERY_KEY);
  if (pattern !== DEFAULT_SIGNAGE_DESIGN_PATTERN) {
    parsed.searchParams.set(SIGNAGE_DESIGN_QUERY_KEY, pattern);
    return parsed.toString();
  }
  // 既定（pattern1）= パラメータ無し。元から無ければ原文維持（正規化を避ける）。
  return had ? parsed.toString() : url;
}
