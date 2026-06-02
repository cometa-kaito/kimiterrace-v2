/**
 * F14 (#128, ADR-021): 気象庁（JMA）無料 JSON 予報の **純粋なパース / 変換** ロジック。
 *
 * ネットワーク I/O は含まない（fixture でモックして単体検証できる、`migration/transform.ts` と同じ方針）。
 * 取得・upsert・retry の I/O 結線は `run.ts`、Cloud Run Job エントリは `weather-job.ts` が担う。
 *
 * ## JMA bosai forecast の形（非公式・無保証, ADR-021 §悪い影響）
 * `https://www.jma.go.jp/bosai/forecast/data/forecast/{areaCode}.json` は配列で、
 *   - `[0]`: 直近 3 日。`timeSeries[0]` = 天気（weatherCodes / weathers / 地域別）、
 *            `timeSeries[1]` = 降水確率（pops）、`timeSeries[2]` = 気温（temps）。
 *   - `[1]`: 週間。`timeSeries[0]` = 週間天気コード + 降水確率、`timeSeries[1]` = 気温（min/max）。
 * フォーマットが予告なく変わりうるため、**全フィールドを optional 扱いで防御的に**読む。読めない値は
 * null にして落とさない（last-known-good を壊さない）。原文 JSON は呼び出し側が `raw` に保全する。
 */

/** 1 地域・1 対象日ぶんに正規化した予報（DB の weather_forecasts 1 行に対応、school_id 非保持）。 */
export interface ParsedForecastDay {
  /** 対象日（JST 暦日 'YYYY-MM-DD'）。一意キーの一部。 */
  forecastDate: string;
  /** JMA 天気コード（アイコンマッピングのキー、例 "100"）。無ければ null。 */
  weatherCode: string | null;
  /** 天気テキスト（例 "晴時々曇"）。無ければ null。 */
  weatherText: string | null;
  /** 最低気温（℃）。取得できない日は null。 */
  tempMin: number | null;
  /** 最高気温（℃）。取得できない日は null。 */
  tempMax: number | null;
  /** 降水確率（%, 0-100）。取得できない日は null。 */
  pop: number | null;
}

/** パース結果（地域コード・地域名 + 日次配列）。 */
export interface ParsedForecast {
  areaCode: string;
  areaName: string | null;
  days: ParsedForecastDay[];
}

/** ISO 日時文字列（JMA の defineDate / timeDefines 値）から JST 暦日 'YYYY-MM-DD' を取り出す。 */
export function toJstDateString(isoLike: unknown): string | null {
  if (typeof isoLike !== "string" || isoLike.length === 0) return null;
  // JMA の timeDefines は "2026-06-02T00:00:00+09:00" 形（既に JST オフセット付き）。
  // タイムゾーン変換でズレないよう、先頭の日付部分（YYYY-MM-DD）をそのまま採る。
  const m = isoLike.match(/^(\d{4}-\d{2}-\d{2})/);
  return m?.[1] ?? null;
}

/** 数値化（文字列 / 数値を受け、空文字・"-"・パース不能は null）。気温・降水確率に使う。 */
export function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.length === 0 || t === "-") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** unknown を配列として安全に取り出す（非配列は []）。 */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** unknown を record として安全に取り出す（非オブジェクトは {}）。 */
function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * JMA forecast JSON（配列）を地域コードごとの日次予報に変換する。
 *
 * 防御的: 構造が欠けても throw せず、読めたぶんだけ `days` に詰める（空配列もありうる）。日付をキーに
 * 天気・降水確率・気温をマージする（JMA は timeSeries ごとに timeDefines が異なるため日付で突合）。
 *
 * @param areaCode 取得に使った地域コード（結果に保持。JSON 側の area code とは独立）。
 * @param json     `forecast/{areaCode}.json` のパース済み JSON（配列想定）。
 */
export function parseJmaForecast(areaCode: string, json: unknown): ParsedForecast {
  const root = asArray(json);
  const near = asRecord(root[0]);
  const nearSeries = asArray(near.timeSeries);

  // 日付 → 部分予報 を貯めるマップ（順序保持のため別途 order 配列）。
  const byDate = new Map<string, ParsedForecastDay>();
  const order: string[] = [];
  const ensure = (dateStr: string): ParsedForecastDay => {
    let day = byDate.get(dateStr);
    if (!day) {
      day = {
        forecastDate: dateStr,
        weatherCode: null,
        weatherText: null,
        tempMin: null,
        tempMax: null,
        pop: null,
      };
      byDate.set(dateStr, day);
      order.push(dateStr);
    }
    return day;
  };

  // --- 地域名 + 天気コード / テキスト（near.timeSeries[0]）---
  let areaName: string | null = null;
  const weatherSeries = asRecord(nearSeries[0]);
  const weatherTimes = asArray(weatherSeries.timeDefines).map(toJstDateString);
  const weatherAreas = asArray(weatherSeries.areas);
  const firstArea = asRecord(weatherAreas[0]);
  const areaMeta = asRecord(firstArea.area);
  if (typeof areaMeta.name === "string") areaName = areaMeta.name;
  const weatherCodes = asArray(firstArea.weatherCodes);
  const weathers = asArray(firstArea.weathers);
  for (let i = 0; i < weatherTimes.length; i++) {
    const dateStr = weatherTimes[i];
    if (!dateStr) continue;
    const day = ensure(dateStr);
    const code = weatherCodes[i];
    if (typeof code === "string" && code.length > 0) day.weatherCode = code;
    const text = weathers[i];
    if (typeof text === "string" && text.length > 0) {
      // JMA の天気テキストは全角スペースで桁揃えされていることがあるため詰める。
      day.weatherText = text.replace(/　/g, "").trim();
    }
  }

  // --- 降水確率（near.timeSeries[1]）。時間帯別に複数あるので日ごとの最大値を採る ---
  const popSeries = asRecord(nearSeries[1]);
  const popTimes = asArray(popSeries.timeDefines).map(toJstDateString);
  const popArea = asRecord(asArray(popSeries.areas)[0]);
  const pops = asArray(popArea.pops);
  for (let i = 0; i < popTimes.length; i++) {
    const dateStr = popTimes[i];
    if (!dateStr) continue;
    const p = parseNumeric(pops[i]);
    if (p == null) continue;
    const day = ensure(dateStr);
    day.pop = day.pop == null ? p : Math.max(day.pop, p);
  }

  // --- 気温（near.timeSeries[2]）。temps は [朝最低, 昼最高, ...] が時刻別に並ぶ。
  //     同一日付に複数値が来るので min/max を畳む ---
  const tempSeries = asRecord(nearSeries[2]);
  const tempTimes = asArray(tempSeries.timeDefines).map(toJstDateString);
  const tempArea = asRecord(asArray(tempSeries.areas)[0]);
  const temps = asArray(tempArea.temps);
  for (let i = 0; i < tempTimes.length; i++) {
    const dateStr = tempTimes[i];
    if (!dateStr) continue;
    const t = parseNumeric(temps[i]);
    if (t == null) continue;
    const day = ensure(dateStr);
    day.tempMin = day.tempMin == null ? t : Math.min(day.tempMin, t);
    day.tempMax = day.tempMax == null ? t : Math.max(day.tempMax, t);
  }

  // --- 週間（root[1]）: 既に near にある日は上書きせず、未カバーの先の日だけ足す ---
  mergeWeekly(root[1], ensure, byDate);

  return { areaCode, areaName, days: order.map((d) => byDate.get(d)).filter(isForecastDay) };
}

/** 週間予報（root[1]）から near でカバーされていない日を補完する。 */
function mergeWeekly(
  weeklyRoot: unknown,
  ensure: (dateStr: string) => ParsedForecastDay,
  byDate: Map<string, ParsedForecastDay>,
): void {
  const weekly = asRecord(weeklyRoot);
  const series = asArray(weekly.timeSeries);

  // [0]: 週間天気コード + 降水確率
  const wk = asRecord(series[0]);
  const wkTimes = asArray(wk.timeDefines).map(toJstDateString);
  const wkArea = asRecord(asArray(wk.areas)[0]);
  const wkCodes = asArray(wkArea.weatherCodes);
  const wkPops = asArray(wkArea.pops);
  for (let i = 0; i < wkTimes.length; i++) {
    const dateStr = wkTimes[i];
    if (!dateStr || byDate.has(dateStr)) continue; // near 優先（重複日は補完しない）
    const day = ensure(dateStr);
    const code = wkCodes[i];
    if (typeof code === "string" && code.length > 0) day.weatherCode = code;
    const p = parseNumeric(wkPops[i]);
    if (p != null) day.pop = p;
  }

  // [1]: 週間気温（tempsMin / tempsMax）
  const wkTemp = asRecord(series[1]);
  const wkTempTimes = asArray(wkTemp.timeDefines).map(toJstDateString);
  const wkTempArea = asRecord(asArray(wkTemp.areas)[0]);
  const tempsMin = asArray(wkTempArea.tempsMin);
  const tempsMax = asArray(wkTempArea.tempsMax);
  for (let i = 0; i < wkTempTimes.length; i++) {
    const dateStr = wkTempTimes[i];
    if (!dateStr) continue;
    const day = byDate.get(dateStr);
    // near にある日は気温も near 優先。週間のみの日だけ埋める。
    if (!day || day.tempMin != null || day.tempMax != null) {
      if (byDate.has(dateStr)) continue;
    }
    const target = ensure(dateStr);
    const lo = parseNumeric(tempsMin[i]);
    const hi = parseNumeric(tempsMax[i]);
    if (lo != null && target.tempMin == null) target.tempMin = lo;
    if (hi != null && target.tempMax == null) target.tempMax = hi;
  }
}

function isForecastDay(d: ParsedForecastDay | undefined): d is ParsedForecastDay {
  return d != null;
}
