/**
 * モニタ（端末）ごとの「授業時間中に広告を出すか止めるか」の **client-safe な定義・型・URL ヘルパ**。
 *
 * 学校全体の授業時間中広告停止（{@link ./ad-suppression}）に対する **端末単位の例外**。既定は「学校の設定に
 * 従う（授業中は停止）」で、モニタごとに「授業中も広告を出す（停止しない）」へ切り替えられる。
 *
 * ## 保持方法（スキーマ非変更・`?design` と同一機構）
 * 端末別デザイン（`design-pattern.ts`）が `tv_devices.signage_url` の `?design=patternN` に載るのと**全く同じ**
 * ように、本設定は同 URL の `?classAds=on` クエリに載せる（**専用列を足さない**＝migration 不要。`tv_devices`
 * スキーマ/クエリを触らない）。既定「学校の設定に従う」は**パラメータ無し**で表す（後方互換：既存 URL は自動的に
 * 既定）。クラストークン経路（`/signage/{classToken}`）はモニタ個体を識別できないが、各端末が開く signage_url の
 * クエリはそのまま各端末のリクエストに載るため、**この方式ならクラス共有トークンの端末でも個別に効く**。
 *
 * ## なぜ列でなく URL クエリか
 * per-monitor 列（`tv_devices.class_ad_exempt` 等）にすると、クラストークン経路のサイネージ描画は端末行を
 * ロードしない（token→{school,class} 解決のみ）ため、**どの端末かを知らず適用できない**。URL クエリなら
 * 端末が開いた URL のクエリがリクエストに載るので、経路を再設計せず端末単位で効かせられる。
 *
 * ## postgres 非依存
 * "use client" な設定フォームと server のサイネージ経路の両方から import するため、DB を引き込まない
 * （`design-pattern.ts` と同じ #148 回避）。
 */

/** signage_url / サイネージ URL に載せる「授業中の広告可否」クエリのキー。 */
export const MONITOR_AD_MODE_QUERY_KEY = "classAds";

/** `?classAds=on` の値（「授業中も広告を出す」= 停止を免除）。既定（follow）はパラメータ無し。 */
const ALWAYS_VALUE = "on";

/**
 * モニタの授業中広告モード。
 * - `follow`: 学校の設定（授業時間中は停止）に従う。**既定**（URL にパラメータ無し）。
 * - `always`: このモニタは授業中も広告を出す（停止を免除）。URL に `?classAds=on`。
 */
export type MonitorAdMode = "follow" | "always";

/** 既定モード（授業中は学校設定に従って停止）。 */
export const DEFAULT_MONITOR_AD_MODE: MonitorAdMode = "follow";

/** 設定 UI（TV 設定編集のドロップダウン）に出すモード名ラベル。 */
export const MONITOR_AD_MODE_LABELS: Record<MonitorAdMode, string> = {
  follow: "学校の設定に従う（授業中は広告を停止）",
  always: "このモニタは授業中も広告を出す",
};

/** 文字列が既知のモードか型ガードする。 */
export function isMonitorAdMode(value: unknown): value is MonitorAdMode {
  return value === "follow" || value === "always";
}

/**
 * サイネージリクエストのクエリ値（`?classAds` の生値）から「授業中の広告停止を免除するか」を判定する。
 * `"on"` のときだけ免除（＝授業中も広告を出す）。それ以外・未指定はすべて既定（学校設定に従う＝停止しうる）。
 * サイネージのページ / ポーリング Route Handler が受け取った searchParam をこれに通す。
 */
export function isMonitorAdExempt(paramValue: string | null | undefined): boolean {
  return paramValue === ALWAYS_VALUE;
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
 * サイネージ URL の `?classAds=` から端末の広告モードを取り出す。`on` は `always`、それ以外・未指定・パース
 * 不能はすべて `follow`（既定）に倒す。
 */
export function getMonitorAdModeFromUrl(url: string | null | undefined): MonitorAdMode {
  const parsed = tryParseUrl(url);
  if (!parsed) return DEFAULT_MONITOR_AD_MODE;
  return parsed.searchParams.get(MONITOR_AD_MODE_QUERY_KEY) === ALWAYS_VALUE ? "always" : "follow";
}

/**
 * サイネージ URL から `classAds` クエリを取り除いた「素の URL」を返す（編集フォームの URL 欄表示用）。
 * `classAds` が無い / パース不能なら原文をそのまま返す（正規化による予期せぬ書き換えを避ける）。
 */
export function stripMonitorAdModeParam(url: string | null | undefined): string {
  if (!url) return "";
  const parsed = tryParseUrl(url);
  if (!parsed) return url;
  if (!parsed.searchParams.has(MONITOR_AD_MODE_QUERY_KEY)) return url;
  parsed.searchParams.delete(MONITOR_AD_MODE_QUERY_KEY);
  return parsed.toString();
}

/**
 * 素の URL に広告モードを合成する（保存時）。既定 `follow` は **パラメータを付けない**（URL を汚さない・
 * 後方互換）。`always` は `?classAds=on` を設定する（既存の classAds 値は置換）。パース不能（相対・空）は
 * そのまま返す（fail-soft。呼出側は事前に http(s) 絶対 URL を検証済み）。
 */
export function applyMonitorAdModeToUrl(url: string, mode: MonitorAdMode): string {
  const parsed = tryParseUrl(url);
  if (!parsed) return url;
  const had = parsed.searchParams.has(MONITOR_AD_MODE_QUERY_KEY);
  parsed.searchParams.delete(MONITOR_AD_MODE_QUERY_KEY);
  if (mode === "always") {
    parsed.searchParams.set(MONITOR_AD_MODE_QUERY_KEY, ALWAYS_VALUE);
    return parsed.toString();
  }
  // 既定（follow）= パラメータ無し。元から無ければ原文維持（正規化を避ける）。
  return had ? parsed.toString() : url;
}
