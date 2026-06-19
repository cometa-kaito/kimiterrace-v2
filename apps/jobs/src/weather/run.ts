import { createHash } from "node:crypto";
import {
  type EnabledCalendarSource,
  type HeatAlertLevel,
  type NormalizedWarning,
  type TenantTx,
  type UpsertCalendarEventInput,
  type WbgtBand,
  createDbClient,
  deleteStaleCalendarEvents,
  listEnabledCalendarSources,
  listSchools,
  resolveJmaAreaCode,
  updateCalendarSourceStatus,
  upsertAirQuality,
  upsertCalendarEvent,
  upsertHeatAlert,
  upsertWeatherForecast,
  upsertWeatherWarning,
  withTenantContext,
} from "@kimiterrace/db";
import { type ParsedCalendarEvent, parseIcs } from "../calendar/ical.js";
import { type DnsResolver, fetchPublicIcs } from "../calendar/safe-fetch.js";
import { type ParsedAirQuality, parseSoramameAir } from "./env-air.js";
import { type ParsedHeatAlert, parseEnvHeatAlert } from "./env-heat.js";
import { type ParsedForecast, parseJmaForecast } from "./jma.js";
import { type ParsedWarningSet, parseJmaWarning } from "./jma-warning.js";

/**
 * F14 (#128, ADR-021): 天気取得バッチの **オーケストレーション + I/O 結線**。
 *
 * - 地域 dedup → JMA 取得 → パース → `weather_forecasts` upsert を 1 サイクルで回す。
 * - 純粋ロジック（パース = `jma.ts`、府県→地域コード = `prefecture-area-map.ts`、地域 dedup =
 *   `collectAreaCodes`）と I/O（fetch / DB）を分け、`fetchArea` と upsert を依存注入することで
 *   ネットワーク・DB なしに `runWeatherFetch` を単体検証できる（`embedding/run.ts` と同じ方針）。
 * - **閉域 / PII 非送信（ADR-021）**: JMA へ送るのは地域コードのみ。端末は外部に出ない（本 Job だけが egress）。
 * - **テナント分離（ルール2）**: 校列挙・天気 upsert はいずれも system_admin context（weather_write_system
 *   policy / system_admin_full_access）。BYPASSRLS は使わない。weather_forecasts は school_id 非保持の
 *   cross-tenant 共有キャッシュ。
 */

/** JMA forecast エンドポイント URL を組む（純関数、テスト容易）。 */
export function jmaForecastUrl(areaCode: string): string {
  return `https://www.jma.go.jp/bosai/forecast/data/forecast/${encodeURIComponent(areaCode)}.json`;
}

/** JMA warning（警報・注意報）エンドポイント URL を組む（純関数、テスト容易）。 */
export function jmaWarningUrl(areaCode: string): string {
  return `https://www.jma.go.jp/bosai/warning/data/warning/${encodeURIComponent(areaCode)}.json`;
}

/** 学校行（地域コード導出に必要な最小形）。 */
export interface SchoolAreaRow {
  prefecture: string | null;
}

/**
 * 学校群の prefecture から、取得すべき JMA 地域コードを **重複排除**して返す（純関数）。
 * 同一府県の複数校は 1 コードに畳む（地域 dedup）。未知の府県は除外する（呼び出し側で件数を監視ログに）。
 */
export function collectAreaCodes(schools: readonly SchoolAreaRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of schools) {
    const code = resolveJmaAreaCode(s.prefecture);
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/** 1 地域ぶんの取得結果（パース済み + 原文。原文は raw 保全に使う）。 */
export interface FetchedArea {
  parsed: ParsedForecast;
  raw: unknown;
}

/** 1 地域ぶんの警報取得結果（パース済み + 原文。ADR-044 相乗り）。 */
export interface FetchedWarning {
  parsed: ParsedWarningSet;
  raw: unknown;
}

/**
 * 1 地域・1 日ぶんの熱中症アラート取得結果（パース済み + 対象日。ADR-044 相乗り 3 例目）。
 * `forecastDate` は環境省 alert CSV の取得対象日（JST 暦日 'YYYY-MM-DD'）。upsert キーの一部。
 */
export interface FetchedHeat {
  parsed: ParsedHeatAlert;
  forecastDate: string;
}

/**
 * 1 地域・1 日ぶんの大気質取得結果（パース済み + 対象日。ADR-046 相乗り 5 例目）。
 * `forecastDate` は取得対象日（JST 暦日 'YYYY-MM-DD'）。upsert キーの一部。
 */
export interface FetchedAir {
  parsed: ParsedAirQuality;
  forecastDate: string;
}

/**
 * ADR-045: 1 校ぶんの公開 iCal 取得結果（パース済みイベント群 + 由来ソース）。per-school フェーズで使う。
 */
export interface FetchedCalendar {
  /** どのソース設定由来か（lastFetchedAt/lastError 更新と sourceId 付与に使う）。 */
  source: EnabledCalendarSource;
  /** パース済みイベント（`parseIcs` 出力）。空もありうる。 */
  events: ParsedCalendarEvent[];
}

/**
 * `runWeatherFetch` の依存（fetch / DB を注入してネットワーク・DB なしで検証可能にする）。
 * 警報（ADR-044 相乗り）の `fetchWarning` / `saveWarning` は **任意**。未指定なら警報取得を skip する
 * （既存の天気のみのテスト・呼び出し側を壊さない後方互換）。
 *
 * ADR-045: 学校行事カレンダー（per-school・tenant_isolation）の `listCalendarSources` / `fetchCalendar` /
 * `saveCalendar` も **任意**。3 つ揃って初めて per-school カレンダーフェーズが走る（地域ループとは独立の別フェーズ）。
 */
export interface WeatherFetchDeps {
  /** 取得対象の地域コードを列挙する（実体は system_admin context の `listSchools` → `collectAreaCodes`）。 */
  listAreaCodes(): Promise<string[]>;
  /** 1 地域を取得・パースする（実体は HTTP fetch + `parseJmaForecast`）。失敗は throw（呼び出し側が捕捉）。 */
  fetchArea(areaCode: string): Promise<FetchedArea>;
  /** パース済み 1 地域ぶんを weather_forecasts に upsert する（実体は system_admin context の upsert）。 */
  saveArea(area: FetchedArea): Promise<number>;
  /** ADR-044: 1 地域の警報を取得・パースする（実体は HTTP fetch + `parseJmaWarning`）。失敗は throw。 */
  fetchWarning?(areaCode: string): Promise<FetchedWarning>;
  /** ADR-044: パース済み警報 1 地域ぶんを weather_warnings に upsert する（実体は system_admin context）。 */
  saveWarning?(areaCode: string, warning: FetchedWarning): Promise<void>;
  /** ADR-044: 1 地域の熱中症アラートを取得・パースする（実体は HTTP fetch + `parseEnvHeatAlert`）。失敗は throw。 */
  fetchHeat?(areaCode: string): Promise<FetchedHeat>;
  /** ADR-044: パース済み熱中症アラート 1 地域ぶんを heat_alerts に upsert する（実体は system_admin context）。 */
  saveHeat?(areaCode: string, heat: FetchedHeat): Promise<void>;
  /** ADR-046: 1 地域の大気質（PM2.5 等）を取得・パースする（実体は HTTP fetch + `parseSoramameAir`）。失敗は throw。 */
  fetchAir?(areaCode: string): Promise<FetchedAir>;
  /** ADR-046: パース済み大気質 1 地域ぶんを air_quality_index に upsert する（実体は system_admin context）。 */
  saveAir?(areaCode: string, air: FetchedAir): Promise<void>;
  /** ADR-045: 有効な学校カレンダーソースを列挙する（実体は system_admin context の `listEnabledCalendarSources`）。 */
  listCalendarSources?(): Promise<EnabledCalendarSource[]>;
  /** ADR-045: 1 校の公開 iCal を取得・パースする（実体は HTTP fetch + `parseIcs`）。失敗は throw（呼び出し側が捕捉）。 */
  fetchCalendar?(source: EnabledCalendarSource): Promise<FetchedCalendar>;
  /**
   * ADR-045: 1 校ぶんのパース済みイベントを upsert（school_id 明示）+ 掃除し、保存件数を返す（実体は system_admin
   * context）。失敗は throw（呼び出し側が捕捉し、lastError を記録）。
   */
  saveCalendar?(fetched: FetchedCalendar): Promise<number>;
  /** ADR-045: ソースの取得結果（成功時刻 / 失敗理由・PII 非格納）を記録する（実体は system_admin context）。 */
  recordCalendarResult?(
    sourceId: string,
    result: { ok: true } | { ok: false; error: string },
  ): Promise<void>;
}

/** バッチ全体のサマリ（Cloud Logging に構造化ログとして残す。secret / PII は含めない）。 */
export interface WeatherFetchSummary {
  /** dedup 後の取得対象地域数。 */
  areas: number;
  /** 取得・保存に成功した地域数。 */
  fetched: number;
  /** upsert した行数（地域 × 日数の合算）。 */
  rowsUpserted: number;
  /** 取得失敗した地域数（既存キャッシュは消さない = last-known-good 維持）。0 が正常。 */
  failed: number;
  /** 取得失敗した地域コード（監視・Sentry 用。生 PII は含まない公開コード）。 */
  failedAreaCodes: string[];
  /** ADR-044: 警報の取得・保存に成功した地域数（fetchWarning 未指定なら 0）。 */
  warningsFetched: number;
  /** ADR-044: 警報の取得・保存に失敗した地域数（天気は壊さない / last-known-good 維持）。0 が正常。 */
  warningsFailed: number;
  /** ADR-044: 警報取得に失敗した地域コード（公開コード、PII でない）。 */
  warningsFailedAreaCodes: string[];
  /** ADR-044: 熱中症アラートの取得・保存に成功した地域数（fetchHeat 未指定なら 0）。 */
  heatFetched: number;
  /** ADR-044: 熱中症アラートの取得・保存に失敗した地域数（天気・警報は壊さない / last-known-good 維持）。0 が正常。 */
  heatFailed: number;
  /** ADR-044: 熱中症アラート取得に失敗した地域コード（公開コード、PII でない）。 */
  heatFailedAreaCodes: string[];
  /** ADR-046: 大気質（PM2.5 等）の取得・保存に成功した地域数（fetchAir 未指定なら 0）。 */
  airFetched: number;
  /** ADR-046: 大気質の取得・保存に失敗した地域数（天気・警報・熱中症は壊さない / last-known-good 維持）。0 が正常。 */
  airFailed: number;
  /** ADR-046: 大気質取得に失敗した地域コード（公開コード、PII でない）。 */
  airFailedAreaCodes: string[];
  /** ADR-045: 取得対象の有効なカレンダーソース数（per-school、listCalendarSources 未指定なら 0）。 */
  calendarSources: number;
  /** ADR-045: 取得・保存に成功した学校数。 */
  calendarFetched: number;
  /** ADR-045: upsert した行事行数（全校合算・挿入 + 更新）。 */
  calendarRowsUpserted: number;
  /** ADR-045: 取得・保存に失敗した学校数（天気系は壊さない / last-known-good 維持）。0 が正常。 */
  calendarFailed: number;
  /** ADR-045: 取得に失敗したソース id（運用・監視用。学校 id ではなくソース id で PII を避ける）。 */
  calendarFailedSourceIds: string[];
}

/**
 * 天気取得バッチ本体（純粋オーケストレーション、fetch/DB は注入）。
 *
 * 1 地域の取得失敗は **その地域だけ skip** し、他地域は続行する（fail-soft）。失敗地域の既存キャッシュは
 * 触らないので last-known-good を維持する（ADR-021 §結果 / NFR02）。全失敗でも例外は投げず summary を返し、
 * 呼び出し側（entrypoint）が failed > 0 を WARN ログ + 非ゼロ終了に使う。
 *
 * ADR-044: 同じ地域コードで **気象警報・注意報も相乗り取得**して weather_warnings に upsert する
 * （`fetchWarning` / `saveWarning` が注入されている場合のみ）。**警報の取得・保存失敗は天気を壊さない**
 * （独立 try/catch）。その地域の警報だけ skip し、既存の警報キャッシュ（last-known-good）は残す。
 *
 * ADR-044（3 例目）: さらに同じ地域コードで **熱中症警戒アラート / WBGT も相乗り取得**して heat_alerts に
 * upsert する（`fetchHeat` / `saveHeat` が注入されている場合のみ）。天気・警報・熱中症は **互いに独立した
 * try/catch** で、いずれかの失敗が他を巻き込まない（fail-soft / last-known-good 維持）。
 *
 * ADR-046（5 例目）: さらに同じ地域コードで **大気質（PM2.5 等）も相乗り取得**して air_quality_index に upsert
 * する（`fetchAir` / `saveAir` が注入されている場合のみ）。これは **最も脆いソース**（そらまめくん = 正規 API
 * 契約不確実の JS SPA）だが、取得層・パーサが完全防御的なため、他指標と同じく独立 try/catch で **大気質の失敗が
 * 天気・警報・熱中症を壊さない**（fail-soft / last-known-good 維持）。
 *
 * ADR-045: 地域ループの **後** に、独立した **per-school カレンダーフェーズ**を回す（`listCalendarSources` /
 * `fetchCalendar` / `saveCalendar` が揃っている場合のみ）。各校の公開 iCal を取得 → 行事を upsert する。1 校の
 * 失敗は **その校だけ skip** し、他校・天気系を壊さない（独立 try/catch・fail-soft）。これは地域コード単位の
 * cross-tenant 共有キャッシュ（天気・警報・熱中症）と異なり、**school_id を持つ tenant_isolation テーブル**への
 * 書込みであり、取得 Job は system_admin context で各校の school_id を明示して書く（ADR-045 §決定 2/3）。
 */
export async function runWeatherFetch(deps: WeatherFetchDeps): Promise<WeatherFetchSummary> {
  const areaCodes = await deps.listAreaCodes();
  let fetched = 0;
  let rowsUpserted = 0;
  const failedAreaCodes: string[] = [];
  let warningsFetched = 0;
  const warningsFailedAreaCodes: string[] = [];
  const warningsEnabled = deps.fetchWarning != null && deps.saveWarning != null;
  let heatFetched = 0;
  const heatFailedAreaCodes: string[] = [];
  const heatEnabled = deps.fetchHeat != null && deps.saveHeat != null;
  let airFetched = 0;
  const airFailedAreaCodes: string[] = [];
  const airEnabled = deps.fetchAir != null && deps.saveAir != null;

  for (const areaCode of areaCodes) {
    try {
      const area = await deps.fetchArea(areaCode);
      const rows = await deps.saveArea(area);
      fetched += 1;
      rowsUpserted += rows;
    } catch {
      // 取得/保存失敗はその地域のみ skip（既存キャッシュは last-known-good として残す）。
      failedAreaCodes.push(areaCode);
    }

    // ADR-044: 警報を相乗り取得。天気の成否とは独立に試行し、失敗しても天気を巻き込まない。
    if (warningsEnabled) {
      try {
        // biome-ignore lint/style/noNonNullAssertion: warningsEnabled で両者の存在を確認済み
        const warning = await deps.fetchWarning!(areaCode);
        // biome-ignore lint/style/noNonNullAssertion: warningsEnabled で両者の存在を確認済み
        await deps.saveWarning!(areaCode, warning);
        warningsFetched += 1;
      } catch {
        // 警報の取得/保存失敗はその地域のみ skip（既存の警報キャッシュは last-known-good として残す）。
        warningsFailedAreaCodes.push(areaCode);
      }
    }

    // ADR-044（3 例目）: 熱中症アラートを相乗り取得。天気・警報の成否とは独立に試行する。
    if (heatEnabled) {
      try {
        // biome-ignore lint/style/noNonNullAssertion: heatEnabled で両者の存在を確認済み
        const heat = await deps.fetchHeat!(areaCode);
        // biome-ignore lint/style/noNonNullAssertion: heatEnabled で両者の存在を確認済み
        await deps.saveHeat!(areaCode, heat);
        heatFetched += 1;
      } catch {
        // 熱中症の取得/保存失敗はその地域のみ skip（既存の熱中症キャッシュは last-known-good として残す）。
        heatFailedAreaCodes.push(areaCode);
      }
    }

    // ADR-046（5 例目）: 大気質（PM2.5 等）を相乗り取得。天気・警報・熱中症の成否とは独立に試行する。
    // 最も脆いソース（そらまめくん）だが、取得層・パーサが防御的なので失敗してもここで吸収して他を巻き込まない。
    if (airEnabled) {
      try {
        // biome-ignore lint/style/noNonNullAssertion: airEnabled で両者の存在を確認済み
        const air = await deps.fetchAir!(areaCode);
        // biome-ignore lint/style/noNonNullAssertion: airEnabled で両者の存在を確認済み
        await deps.saveAir!(areaCode, air);
        airFetched += 1;
      } catch {
        // 大気質の取得/保存失敗はその地域のみ skip（既存の大気質キャッシュは last-known-good として残す）。
        airFailedAreaCodes.push(areaCode);
      }
    }
  }

  // ADR-045: per-school カレンダーフェーズ（地域ループとは独立）。1 校の失敗は他校・天気系を壊さない（fail-soft）。
  let calendarSources = 0;
  let calendarFetched = 0;
  let calendarRowsUpserted = 0;
  const calendarFailedSourceIds: string[] = [];
  const calendarEnabled =
    deps.listCalendarSources != null && deps.fetchCalendar != null && deps.saveCalendar != null;
  if (calendarEnabled) {
    let sources: EnabledCalendarSource[] = [];
    try {
      // biome-ignore lint/style/noNonNullAssertion: calendarEnabled で存在確認済み
      sources = await deps.listCalendarSources!();
    } catch {
      // 列挙自体の失敗（DB エラー等）は per-school 成果ゼロで続行（天気系の summary は壊さない）。
      sources = [];
    }
    calendarSources = sources.length;
    for (const source of sources) {
      try {
        // biome-ignore lint/style/noNonNullAssertion: calendarEnabled で存在確認済み
        const fetched = await deps.fetchCalendar!(source);
        // biome-ignore lint/style/noNonNullAssertion: calendarEnabled で存在確認済み
        const rows = await deps.saveCalendar!(fetched);
        calendarFetched += 1;
        calendarRowsUpserted += rows;
        // 成功記録（lastFetchedAt 更新 / lastError クリア）。記録失敗は本校の成果には影響させない。
        await deps.recordCalendarResult?.(source.id, { ok: true });
      } catch (err) {
        // 取得 / 保存失敗はその校のみ skip（既存の行事キャッシュは last-known-good として残す）。
        calendarFailedSourceIds.push(source.id);
        const message =
          err instanceof Error ? `${err.name}: ${err.message}` : "calendar fetch failed";
        // 失敗理由（PII 非格納）を記録。記録自体の失敗は握り潰す（fail-soft の外周）。
        await deps.recordCalendarResult?.(source.id, { ok: false, error: message }).catch(() => {});
      }
    }
  }

  return {
    areas: areaCodes.length,
    fetched,
    rowsUpserted,
    failed: failedAreaCodes.length,
    failedAreaCodes,
    warningsFetched,
    warningsFailed: warningsFailedAreaCodes.length,
    warningsFailedAreaCodes,
    heatFetched,
    heatFailed: heatFailedAreaCodes.length,
    heatFailedAreaCodes,
    airFetched,
    airFailed: airFailedAreaCodes.length,
    airFailedAreaCodes,
    calendarSources,
    calendarFetched,
    calendarRowsUpserted,
    calendarFailed: calendarFailedSourceIds.length,
    calendarFailedSourceIds,
  };
}

/** HTTP 取得の設定（HTTP マナー: User-Agent / timeout）。 */
export interface HttpFetchConfig {
  /** 明示 User-Agent（ADR-021 §HTTP マナー。連絡先を含めて JMA に対し礼儀正しく）。 */
  userAgent: string;
  /** タイムアウト（ms）。既定 10s。 */
  timeoutMs?: number;
  /** テスト差し替え用の fetch 実装（既定は global fetch）。 */
  fetchImpl?: typeof fetch;
  /**
   * ADR-045 §SSRF: 半信頼の `ics_url` を SSRF セーフに取得する際の DNS resolver（テスト差し替え用）。
   * 未指定なら `fetchPublicIcs` の既定（`dns/promises` lookup, all:true）を使う。JMA/環境省は固定 URL なので
   * 天気・警報・熱中症の取得には使わない（カレンダーのみ）。
   */
  icsResolver?: DnsResolver;
  /** ADR-045 §SSRF: iCal レスポンスのサイズ上限（bytes）。既定 5MB（巨大 body DoS 回避）。 */
  icsMaxBytes?: number;
  /** ADR-045 §SSRF: iCal 取得で追従するリダイレクトの最大数。既定 3（各ホップを再検証）。 */
  icsMaxRedirects?: number;
}

/** ADR-045: 1 ソースあたり upsert する VEVENT の総数上限（巨大 iCal による行量産・DoS 回避）。 */
export const MAX_EVENTS_PER_SOURCE = 2000;

/**
 * 1 地域を JMA から HTTP 取得しパースする（実 I/O）。timeout / 明示 User-Agent を付ける。
 * 非 2xx・タイムアウト・JSON パース不能は throw（`runWeatherFetch` が地域単位で捕捉して skip）。
 */
export async function fetchAreaFromJma(
  areaCode: string,
  config: HttpFetchConfig,
): Promise<FetchedArea> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // `?? 10_000` は nullish のみ。NaN（非数値 env 由来）は素通りし `setTimeout(abort, NaN)` ≒ 即 abort に
  // なるため、有限値でなければ既定 10s に倒す（多層防御）。
  const timeoutMs = Number.isFinite(config.timeoutMs) ? (config.timeoutMs as number) : 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(jmaForecastUrl(areaCode), {
      method: "GET",
      headers: { "User-Agent": config.userAgent, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`JMA forecast 取得失敗: areaCode=${areaCode} status=${res.status}`);
    }
    const raw: unknown = await res.json();
    return { parsed: parseJmaForecast(areaCode, raw), raw };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR-044: 1 地域の警報・注意報を JMA から HTTP 取得しパースする（実 I/O）。`fetchAreaFromJma` に倣う
 * （timeout / 明示 User-Agent）。非 2xx・タイムアウト・JSON パース不能は throw（`runWeatherFetch` が地域
 * 単位で捕捉し、天気を巻き込まずその地域の警報だけ skip する）。
 */
export async function fetchWarningFromJma(
  areaCode: string,
  config: HttpFetchConfig,
): Promise<FetchedWarning> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // 非数値（NaN）は素通りで即 abort になるため、有限値でなければ既定 10s に倒す（`fetchAreaFromJma` と同じ）。
  const timeoutMs = Number.isFinite(config.timeoutMs) ? (config.timeoutMs as number) : 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(jmaWarningUrl(areaCode), {
      method: "GET",
      headers: { "User-Agent": config.userAgent, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`JMA warning 取得失敗: areaCode=${areaCode} status=${res.status}`);
    }
    const raw: unknown = await res.json();
    return { parsed: parseJmaWarning(areaCode, raw), raw };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR-044: 環境省 alert CSV の日付次元（JST 暦日）を組み立てる純関数（テスト容易）。
 * `at`（既定 now）を JST に変換し、`{ yyyy, yyyymmdd, isoDate }` を返す。サーバ TZ に依存しないよう UTC から
 * +9h して算出する（Cloud Run は UTC 既定）。
 */
export function jstHeatDateParts(at: Date = new Date()): {
  yyyy: string;
  yyyymmdd: string;
  isoDate: string;
} {
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = String(jst.getUTCFullYear());
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  return { yyyy, yyyymmdd: `${yyyy}${mm}${dd}`, isoDate: `${yyyy}-${mm}-${dd}` };
}

/**
 * ADR-044: 環境省「熱中症予防情報サイト」alert CSV の URL を組む（純関数、テスト容易）。
 * 形式（確認済 2026 シーズン）: `https://www.wbgt.env.go.jp/alert/dl/{YYYY}/alert_{YYYYMMDD}_{HH}.csv`。
 * `{HH}` は発表時刻（環境省は **05:00 / 17:00 JST** に当日・翌日アラートを発表）。`hour` 既定は `"17"`
 * （後方互換）。実取得は `heatAlertCandidates` が時刻非依存に最新候補を組むので、本関数の既定値には依存しない。
 * CSV は **全国 1 ファイル**（地域コードは URL に含めない）。
 */
export function envHeatAlertUrl(yyyy: string, yyyymmdd: string, hour = "17"): string {
  return `https://www.wbgt.env.go.jp/alert/dl/${encodeURIComponent(yyyy)}/alert_${encodeURIComponent(yyyymmdd)}_${encodeURIComponent(hour)}.csv`;
}

/** ADR-044: 環境省 alert CSV の URL 候補（年・日付・発表時刻の 3 次元。最新順に並ぶ）。 */
export interface HeatAlertCandidate {
  /** 発表日の西暦（URL の `/dl/{yyyy}/` 部分）。 */
  yyyy: string;
  /** 発表日（`YYYYMMDD`、URL の `alert_{yyyymmdd}_` 部分）。 */
  yyyymmdd: string;
  /** 発表時刻（`"17"` / `"05"`、URL の `_{hour}.csv` 部分）。 */
  hour: string;
}

/**
 * ADR-044: 環境省 alert CSV の取得候補を **最新順**で組み立てる純関数（テスト容易）。
 *
 * ★ 取得時刻(HH)非依存化（本 fix の核）: 環境省は **05:00 と 17:00 JST** に当日・翌日アラートを発表し、
 * ファイル名は `alert_{発表日YYYYMMDD}_{HH}.csv`（HH∈{05,17}）。従来は「今日 17 時ファイル」固定で取りに行くため、
 * Job が 17 時前に走るとその日の 17 時ファイルがまだ無く 404 → 熱中症だけ fail-soft 失敗していた（prod 実測）。
 * そこで取得時刻に依存せず **最新の利用可能ファイルを最新順に試行し、最初の 2xx を採用**できるよう候補を返す。
 *
 * 返す候補（最新順）: `今日_17 → 今日_05 → 昨日_17`。これで:
 * - now ≥ 17 時 JST → 今日 17 が存在し先頭で当たる。
 * - 05〜17 時 JST → 今日 17 はまだ無く 404、今日 05 で当たる。
 * - 05 時前 JST → 今日 17/05 とも無く 404、昨日 17 で当たる（昨日 17 時発表は当日分アラートを含むので当日表示で正）。
 *
 * 日付ロールオーバー（昨日）は **UTC+9 基準**で算出する（サーバ TZ 非依存。`jstHeatDateParts` の +9h 流儀を再利用）。
 */
export function heatAlertCandidates(at: Date = new Date()): HeatAlertCandidate[] {
  const today = jstHeatDateParts(at);
  // 昨日（JST 暦日）: 24h 前の同時刻を JST 換算する（+9h 流儀は jstHeatDateParts に委譲、二重補正しない）。
  const yesterday = jstHeatDateParts(new Date(at.getTime() - 24 * 60 * 60 * 1000));
  return [
    { yyyy: today.yyyy, yyyymmdd: today.yyyymmdd, hour: "17" },
    { yyyy: today.yyyy, yyyymmdd: today.yyyymmdd, hour: "05" },
    { yyyy: yesterday.yyyy, yyyymmdd: yesterday.yyyymmdd, hour: "17" },
  ];
}

/**
 * ADR-044: 1 地域の熱中症アラートを環境省 alert CSV から HTTP 取得しパースする（実 I/O）。`fetchWarningFromJma`
 * に倣う（timeout / 明示 User-Agent）。
 *
 * ★ 公開時刻(HH)非依存（本 fix）: 環境省は 05:00 / 17:00 JST に発表し、ファイル名は `alert_{発表日}_{HH}.csv`。
 * 従来は「今日 17 時ファイル」固定で取りに行き、Job が 17 時前に走るとそのファイルがまだ無く 404 → 熱中症だけ
 * fail-soft 失敗していた（prod 実測 heatFailed=1）。本関数は `heatAlertCandidates` が返す **最新順候補**
 * （今日17 → 今日05 → 昨日17）を順に GET し、**最初の 2xx を採用**して取得時刻に依存せず常に最新を当てる。
 *
 * 環境省 CSV は **全国 1 ファイル**（地域コードは URL に含まれない）なので、採用した CSV 全文を取得して
 * `parseEnvHeatAlert(areaCode, csvText)` で該当地域行だけを抜き出す。PoC 規模（dedup 後 1〜数地域）では同一 CSV を
 * 地域ごとに再取得しても許容（15 分キャッシュ・低頻度起動）。地域数が増えたら 1 サイクル 1 取得への最適化を
 * 検討する（follow-up、ADR-044 §再検討トリガ）。
 *
 * **全候補が非 2xx / 失敗なら throw**（`runWeatherFetch` が地域単位で捕捉し、天気・警報を巻き込まずその地域の
 * 熱中症だけ skip する＝fail-soft / last-known-good 維持）。各候補は個別の `AbortController` で timeout を独立に
 * 計測する（既定 10s）。`forecastDate` は **当日（JST 暦日）**（昨日 17 時ファイルでも当日分アラートを含むため当日で正）。
 */
export async function fetchHeatFromEnv(
  areaCode: string,
  config: HttpFetchConfig,
): Promise<FetchedHeat> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // 非数値（NaN）は素通りで即 abort になるため、有限値でなければ既定 10s に倒す（`fetchAreaFromJma` と同じ）。
  const timeoutMs = Number.isFinite(config.timeoutMs) ? (config.timeoutMs as number) : 10_000;
  const { isoDate } = jstHeatDateParts();
  const candidates = heatAlertCandidates();
  // 最後に観測した失敗の要約（全候補不発時に投げる例外メッセージ用。生レスポンス・PII は載せない）。
  let lastFailure = "no candidates";
  for (const { yyyy, yyyymmdd, hour } of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(envHeatAlertUrl(yyyy, yyyymmdd, hour), {
        method: "GET",
        headers: { "User-Agent": config.userAgent, Accept: "text/csv,text/plain" },
        signal: controller.signal,
      });
      if (!res.ok) {
        // 非 2xx はこの候補を諦めて次の候補へ（今日 17 が未発表で 404 等は想定内）。
        lastFailure = `${yyyymmdd}_${hour} status=${res.status}`;
        continue;
      }
      const csvText: string = await res.text();
      return { parsed: parseEnvHeatAlert(areaCode, csvText), forecastDate: isoDate };
    } catch (err) {
      // タイムアウト / ネットワーク失敗もこの候補を諦めて次の候補へ。
      lastFailure = `${yyyymmdd}_${hour} ${err instanceof Error ? err.name : "fetch failed"}`;
    } finally {
      clearTimeout(timer);
    }
  }
  // 全候補が非 2xx / 失敗 → throw（呼び出し側が地域単位で捕捉し fail-soft）。
  throw new Error(`env heat alert 取得失敗: areaCode=${areaCode} lastFailure=${lastFailure}`);
}

/**
 * ADR-046: 環境省「そらまめくん」大気質エンドポイント URL を組む（純関数、テスト容易）。
 *
 * ★ ソースの脆さ（ADR-046 §残存リスク①）: そらまめくんは **正規の公開 API 契約が確認できない JS SPA**。
 * 確証点として `https://soramame.env.go.jp/` 配下の地域別データ参照（測定局コードベース）が keyless である
 * ことは確認したが、府県コードを直接キーにできる安定 JSON エンドポイントは確認できなかった。本関数は府県予報区
 * コードを用いた地域別プレビュー JSON への **想定 URL** を組む（固定ホスト = soramame.env.go.jp）。形式が想定外でも
 * 取得・パースは fail-soft なので、合わなければその地域は skip（last-known-good 維持）→ follow-up で実 URL を確定する。
 *
 * ★ SSRF（ADR-045 §SSRF）非対象: ホストは **固定**（soramame.env.go.jp）で半信頼入力に由来しないため、
 * カレンダー（school_admin 登録の可変 URL）のような SSRF ガード（`fetchPublicIcs`）は不要。JMA / 環境省 alert CSV と
 * 同じ固定 URL 扱い。
 */
export function soramameAirUrl(areaCode: string): string {
  // 府県予報区コードの上 2 桁が都道府県コードに対応する（例 '210000' → 岐阜 '21'）。そらまめくんの地域別参照は
  // 都道府県単位に近いため、想定 URL は都道府県コードでスコープする（不確実なため形式変化は parser が吸収）。
  const prefCode = encodeURIComponent(areaCode.slice(0, 2));
  return `https://soramame.env.go.jp/data/sokutei/code/${prefCode}.json`;
}

/**
 * ADR-046: 1 地域の大気質（PM2.5 等）をそらまめくんから HTTP 取得しパースする（実 I/O）。`fetchHeatFromEnv` に倣う
 * （timeout / 明示 User-Agent / 固定ホスト）。
 *
 * ★ 最も脆いソース: そらまめくんは正規 API 契約が不確実な JS SPA（実質スクレイプ相当）。本関数は想定 JSON を
 * 取得し、レスポンスから「該当地域の代表測定値らしきオブジェクト」を素朴に取り出して `parseSoramameAir` に渡す。
 * フィールド名・構造は parser 側で完全防御的に当てる（取れなければ全 null・throw しない）。非 2xx・タイムアウト・
 * JSON パース不能は throw（`runWeatherFetch` が地域単位で捕捉し、天気・警報・熱中症を巻き込まずその地域の大気質
 * だけ skip する）。`forecastDate` は **当日（JST 暦日）**（熱中症と同じ日付次元の組み立てを再利用）。
 */
export async function fetchAirFromEnv(
  areaCode: string,
  config: HttpFetchConfig,
): Promise<FetchedAir> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // 非数値（NaN）は素通りで即 abort になるため、有限値でなければ既定 10s に倒す（`fetchAreaFromJma` と同じ）。
  const timeoutMs = Number.isFinite(config.timeoutMs) ? (config.timeoutMs as number) : 10_000;
  const { isoDate } = jstHeatDateParts();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(soramameAirUrl(areaCode), {
      method: "GET",
      headers: { "User-Agent": config.userAgent, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`soramame air 取得失敗: areaCode=${areaCode} status=${res.status}`);
    }
    const raw: unknown = await res.json();
    // レスポンスから「該当地域の代表測定値らしきオブジェクト」を素朴に取り出す（配列なら先頭、object ならそのまま）。
    // 構造不確実のため parser 側で完全防御的に当てる（ここでの抽出ミスも parser が全 null に倒す）。
    const record: unknown = Array.isArray(raw) ? raw[0] : raw;
    return { parsed: parseSoramameAir(areaCode, record), forecastDate: isoDate };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR-045: 1 校の公開 iCal/ICS を **SSRF セーフに** HTTP 取得しパースする（実 I/O）。
 *
 * ★ SSRF（ADR-045 §SSRF）: `source.icsUrl` は school_admin が登録する半信頼入力。weather Job は egress=
 * ALL_TRAFFIC で VPC 内（Cloud SQL プライベート IP / GCP メタデータ 169.254.169.254 に到達可）なので、素の
 * fetch だと内部 URL を入れられてブラインド SSRF になる。`fetchPublicIcs` 経由で **https 限定・プライベート/
 * 予約 IP 拒否・リダイレクト各ホップ再検証・サイズ上限・認証情報不送信**を強制する（JMA/環境省は固定 URL なので
 * 対象外で、この経路はカレンダーのみ）。
 *
 * 取込上限（ADR-045 §SSRF・MINOR）: 1 ソースあたり upsert する VEVENT は `MAX_EVENTS_PER_SOURCE` 件まで。
 * 超過分は **切り捨てつつ WARN ログで件数を明示**（沈黙の切り捨てをしない）。
 *
 * 検証失敗・非 2xx・タイムアウト・サイズ超過は throw（`runWeatherFetch` が校単位で捕捉し、天気系を巻き込まず
 * その校だけ skip する）。壊れた iCal は `parseIcs` が空 / 部分配列を返す（throw しない・fail-soft）。
 */
export async function fetchIcs(
  source: EnabledCalendarSource,
  config: HttpFetchConfig,
): Promise<FetchedCalendar> {
  const fetchOptions = {
    userAgent: config.userAgent,
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.icsResolver !== undefined ? { resolver: config.icsResolver } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.icsMaxBytes !== undefined ? { maxBytes: config.icsMaxBytes } : {}),
    ...(config.icsMaxRedirects !== undefined ? { maxRedirects: config.icsMaxRedirects } : {}),
  };
  // SSRF 検証（https 限定・プライベート/予約 IP 拒否・リダイレクト各ホップ再検証）+ サイズ上限付きで取得。
  // 検証 NG / 非 2xx / サイズ超過は throw（呼び出し側がその校だけ skip）。生 URL はメッセージに載せない。
  const text = await fetchPublicIcs(source.icsUrl, fetchOptions);
  const parsed = parseIcs(text);
  // ADR-045 §取込上限: 1 ソース総 VEVENT 数を MAX_EVENTS_PER_SOURCE でクランプ（巨大 iCal の行量産を防ぐ）。
  if (parsed.length > MAX_EVENTS_PER_SOURCE) {
    const dropped = parsed.length - MAX_EVENTS_PER_SOURCE;
    // ★ 沈黙の切り捨て禁止: 何件落としたか構造化 WARN で明示（sourceId は PII でない / URL・本文は載せない）。
    // biome-ignore lint/suspicious/noConsole: Cloud Run Job の構造化運用ログ（Cloud Logging へ出力）。debug 用途でない。
    console.warn(
      JSON.stringify({
        event: "calendar.ingest.truncated",
        sourceId: source.id,
        parsed: parsed.length,
        kept: MAX_EVENTS_PER_SOURCE,
        dropped,
      }),
    );
    return { source, events: parsed.slice(0, MAX_EVENTS_PER_SOURCE) };
  }
  return { source, events: parsed };
}

/**
 * ADR-045: iCal UID が無いイベントの **安定キー**を生成する純関数。`(source.id, startDate, summary)` の
 * SHA-256 から決定論的に作るので、再取得しても同じ UID になり upsert が冪等になる（毎回新 UUID だと行が増殖する）。
 * `summary` 等に PII が無い運用前提（schema コメント）だが、ハッシュ化するので原文はキーに露出しない。
 */
export function stableEventUid(sourceId: string, ev: ParsedCalendarEvent): string {
  if (ev.uid) return ev.uid;
  const basis = `${sourceId}|${ev.startDate}|${ev.summary ?? ""}|${ev.startAt?.toISOString() ?? ""}`;
  return `gen-${createHash("sha256").update(basis).digest("hex").slice(0, 32)}`;
}

/** 実行時の設定（DB 接続 / User-Agent。DATABASE_URL は Secret Manager 経由、ルール5）。 */
export interface RunWeatherFetchConfig {
  /** DB 接続文字列（kimiterrace_app ロール）。Secret Manager 経由で注入（ルール5）。 */
  databaseUrl: string;
  /** JMA への明示 User-Agent（連絡先を含める。ADR-021 §HTTP マナー）。 */
  userAgent: string;
  /** HTTP タイムアウト（ms）。 */
  timeoutMs?: number;
  /** テスト用: BYPASSRLS 接続をアプリロールへ降格する SET LOCAL ROLE 先。本番は未指定。 */
  appRole?: string;
}

/**
 * 実 PG + JMA で天気取得バッチを実行する。接続は本関数が開き、終了時に必ず閉じる。
 * env 読取・プロセス終了コードは entrypoint（`weather-job.ts`）が担う（`embedding/run.ts` と同じ分離）。
 */
export async function runWeatherFetchBatch(
  config: RunWeatherFetchConfig,
): Promise<WeatherFetchSummary> {
  const { sql, db } = createDbClient(config.databaseUrl);
  const appRoleOptions = config.appRole !== undefined ? { appRole: config.appRole } : {};
  const httpConfig: HttpFetchConfig = {
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
  };
  try {
    return await runWeatherFetch({
      // 校列挙は system_admin context（全校 SELECT、ルール2）。BYPASSRLS 不使用。
      listAreaCodes: async () => {
        const schools = await withTenantContext(
          db,
          { role: "system_admin" },
          (tx) => listSchools(tx),
          appRoleOptions,
        );
        return collectAreaCodes(schools);
      },
      fetchArea: (areaCode) => fetchAreaFromJma(areaCode, httpConfig),
      // 天気 upsert は system_admin context（weather_write_system policy が書込みを system に限定）。
      saveArea: (area) =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => saveForecastDays(tx, area),
          appRoleOptions,
        ),
      // ADR-044: 警報の相乗り取得。天気と同じ httpConfig / system context を再利用する。
      fetchWarning: (areaCode) => fetchWarningFromJma(areaCode, httpConfig),
      // 警報 upsert も system_admin context（weather_warnings_write_system policy が書込みを system に限定）。
      saveWarning: (_areaCode, warning) =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => saveWarningRow(tx, warning),
          appRoleOptions,
        ),
      // ADR-044（3 例目）: 熱中症アラートの相乗り取得。天気・警報と同じ httpConfig / system context を再利用する。
      fetchHeat: (areaCode) => fetchHeatFromEnv(areaCode, httpConfig),
      // 熱中症 upsert も system_admin context（heat_alerts_write_system policy が書込みを system に限定）。
      saveHeat: (_areaCode, heat) =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => saveHeatRow(tx, heat),
          appRoleOptions,
        ),
      // ADR-046（5 例目）: 大気質（PM2.5 等）の相乗り取得。天気・警報・熱中症と同じ httpConfig / system context を再利用する。
      fetchAir: (areaCode) => fetchAirFromEnv(areaCode, httpConfig),
      // 大気質 upsert も system_admin context（air_quality_index_write_system policy が書込みを system に限定）。
      saveAir: (_areaCode, air) =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => saveAirRow(tx, air),
          appRoleOptions,
        ),
      // ADR-045: per-school カレンダーフェーズ。列挙・upsert・掃除・状態記録すべて system_admin context
      // （school_calendar_* の system_admin_full_access policy が cross-tenant 書込みを許す。BYPASSRLS 不使用）。
      // 列挙は RLS の全校 SELECT、書込みは各校の school_id を明示する（tenant_isolation テーブル、ルール2）。
      listCalendarSources: () =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => listEnabledCalendarSources(tx),
          appRoleOptions,
        ),
      fetchCalendar: (source) => fetchIcs(source, httpConfig),
      saveCalendar: (fetched) =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => saveCalendarRows(tx, fetched),
          appRoleOptions,
        ),
      recordCalendarResult: (sourceId, result) =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => updateCalendarSourceStatus(tx, sourceId, result),
          appRoleOptions,
        ),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** パース済み 1 地域の日次予報を weather_forecasts に upsert し、保存行数を返す。 */
async function saveForecastDays(tx: TenantTx, area: FetchedArea): Promise<number> {
  let rows = 0;
  for (const day of area.parsed.days) {
    await upsertWeatherForecast(tx, {
      areaCode: area.parsed.areaCode,
      areaName: area.parsed.areaName,
      source: "jma",
      forecastDate: day.forecastDate,
      weatherCode: day.weatherCode,
      weatherText: day.weatherText,
      tempMin: day.tempMin,
      tempMax: day.tempMax,
      pop: day.pop,
      // 原文 JSON を全日共通で保全（JMA bosai は非公式・無保証、後追い解析用、ADR-021 §悪い影響）。
      raw: area.raw,
    });
    rows += 1;
  }
  return rows;
}

/**
 * ADR-044: パース済み 1 地域の警報・注意報を weather_warnings に upsert する（現況 1 行、ON CONFLICT
 * (area_code, source)）。`ParsedWarning[]` は db の `NormalizedWarning[]` と構造一致（手書きドメイン型を
 * 作らず upsert 入力にそのまま渡す。ルール3）。
 */
async function saveWarningRow(tx: TenantTx, warning: FetchedWarning): Promise<void> {
  const { parsed } = warning;
  await upsertWeatherWarning(tx, {
    areaCode: parsed.areaCode,
    source: "jma",
    reportDatetime: parsed.reportDatetime ? new Date(parsed.reportDatetime) : null,
    headline: parsed.headline,
    maxLevel: parsed.maxLevel,
    // `ParsedWarning[]` は db の `NormalizedWarning[]` と構造一致（ルール3: 手書きドメイン型を作らず
    // パーサ出力をそのまま upsert 入力へパススルー）。`satisfies` で両者がズレたらコンパイル時に検出する
    // （将来どちらか片側にだけフィールドを足した場合の silent drift を防ぐ）。
    warnings: parsed.warnings satisfies NormalizedWarning[],
    // 原文 JSON を保全（JMA bosai は非公式・無保証、後追い解析用、ADR-044 §残存リスク①）。
    raw: warning.raw,
  });
}

/**
 * ADR-044: パース済み 1 地域・1 日の熱中症アラートを heat_alerts に upsert する（ON CONFLICT
 * (area_code, source, forecast_date)）。パーサ出力（`ParsedHeatAlert`）の段階・WBGT をそのまま upsert 入力へ
 * パススルーする（ルール3: 手書きドメイン型を作らない）。alertLevel / wbgtBand は db enum 型と構造一致し、
 * `satisfies` で両者がズレたらコンパイル時に検出する（silent drift 防止）。
 */
async function saveHeatRow(tx: TenantTx, heat: FetchedHeat): Promise<void> {
  const { parsed } = heat;
  await upsertHeatAlert(tx, {
    areaCode: parsed.areaCode,
    areaName: parsed.areaName,
    source: "env_moe",
    forecastDate: heat.forecastDate,
    // パーサ出力を db enum 型へパススルー（ルール3）。`satisfies` で型がズレたらコンパイル時に検出する。
    alertLevel: parsed.alertLevel satisfies HeatAlertLevel,
    wbgtMax: parsed.wbgtMax,
    wbgtBand: parsed.wbgtBand satisfies WbgtBand | null,
    // 原文（環境省 CSV の該当地域行を正規化したオブジェクト）を保全（非公式・無保証、後追い解析用）。
    raw: parsed.raw,
  });
}

/**
 * ADR-046: パース済み 1 地域・1 日の大気質を air_quality_index に upsert する（ON CONFLICT
 * (area_code, source, forecast_date)）。パーサ出力（`ParsedAirQuality`）の数値・区分をそのまま upsert 入力へ
 * パススルーする（ルール3: 手書きドメイン型を作らない）。UV は本 PR 未取得なので uvIndex / uvBand は null のまま。
 */
async function saveAirRow(tx: TenantTx, air: FetchedAir): Promise<void> {
  const { parsed } = air;
  await upsertAirQuality(tx, {
    areaCode: parsed.areaCode,
    areaName: parsed.areaName,
    source: "env_soramame",
    forecastDate: air.forecastDate,
    pm25: parsed.pm25,
    pm25Band: parsed.pm25Band,
    oxidant: parsed.oxidant,
    // UV は本 PR では取得しない（GRIB2 のみ・follow-up）。パーサ出力も常に null。
    uvIndex: parsed.uvIndex,
    uvBand: parsed.uvBand,
    // 原文（そらまめくんの代表値を正規化したオブジェクト）を保全（非公式・無保証、後追い解析用）。
    raw: parsed.raw,
  });
}

/**
 * ADR-045: 1 校ぶんのパース済みイベントを upsert（school_id 明示）+ 掃除し、upsert 行数を返す（system context）。
 *
 * - 各イベントに `(school_id, uid)` 一意のため安定 UID を付与（`stableEventUid`、欠落 UID も冪等化）。
 * - upsert 後、**iCal に残っている UID 群**を keepUids として `deleteStaleCalendarEvents` に渡し、消えた行事を掃除する
 *   （keepUids 空 = 取得 0 件は誤爆防止で掃除しない＝last-known-good を残す。query 層の安全弁）。
 * - 取得 Job の書込みなので created_by/updated_by = null（システム）。
 */
async function saveCalendarRows(tx: TenantTx, fetched: FetchedCalendar): Promise<number> {
  const { source, events } = fetched;
  const keepUids: string[] = [];
  let rows = 0;
  for (const ev of events) {
    const uid = stableEventUid(source.id, ev);
    const input: UpsertCalendarEventInput = {
      schoolId: source.schoolId,
      uid,
      summary: ev.summary,
      startDate: ev.startDate,
      endDate: ev.endDate,
      startAt: ev.startAt,
      endAt: ev.endAt,
      allDay: ev.allDay,
      location: ev.location,
      sourceId: source.id,
      // 原文（パース済み生プロパティ map）を保全（iCal 実装差の後追い解析用）。
      raw: ev.raw,
    };
    await upsertCalendarEvent(tx, input);
    keepUids.push(uid);
    rows += 1;
  }
  // 消えた行事の掃除（keepUids 空なら query 層が no-op で last-known-good を残す）。
  await deleteStaleCalendarEvents(tx, source.schoolId, keepUids);
  return rows;
}
