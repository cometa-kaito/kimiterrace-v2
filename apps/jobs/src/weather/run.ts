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
  upsertCalendarEvent,
  upsertHeatAlert,
  upsertWeatherForecast,
  upsertWeatherWarning,
  withTenantContext,
} from "@kimiterrace/db";
import { type ParsedCalendarEvent, parseIcs } from "../calendar/ical.js";
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
}

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
 * `{HH}` は発表時刻（環境省は前日 17 時 / 当日 5 時に翌日・当日アラートを発表）。本スライスは前日 17 時発表
 * （当日 + 翌日を含む）を既定に用いる。CSV は **全国 1 ファイル**（地域コードは URL に含めない）。
 */
export function envHeatAlertUrl(yyyy: string, yyyymmdd: string, hour = "17"): string {
  return `https://www.wbgt.env.go.jp/alert/dl/${encodeURIComponent(yyyy)}/alert_${encodeURIComponent(yyyymmdd)}_${encodeURIComponent(hour)}.csv`;
}

/**
 * ADR-044: 1 地域の熱中症アラートを環境省 alert CSV から HTTP 取得しパースする（実 I/O）。`fetchWarningFromJma`
 * に倣う（timeout / 明示 User-Agent）。
 *
 * 環境省 CSV は **全国 1 ファイル**（地域コードは URL に含まれない）なので、本関数は CSV 全文を取得して
 * `parseEnvHeatAlert(areaCode, csvText)` で該当地域行だけを抜き出す。PoC 規模（dedup 後 1〜数地域）では同一 CSV を
 * 地域ごとに再取得しても許容（15 分キャッシュ・低頻度起動）。地域数が増えたら 1 サイクル 1 取得への最適化を
 * 検討する（follow-up、ADR-044 §再検討トリガ）。非 2xx・タイムアウトは throw（`runWeatherFetch` が地域単位で
 * 捕捉し、天気・警報を巻き込まずその地域の熱中症だけ skip する）。`forecastDate` は **当日（JST 暦日）**。
 */
export async function fetchHeatFromEnv(
  areaCode: string,
  config: HttpFetchConfig,
): Promise<FetchedHeat> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // 非数値（NaN）は素通りで即 abort になるため、有限値でなければ既定 10s に倒す（`fetchAreaFromJma` と同じ）。
  const timeoutMs = Number.isFinite(config.timeoutMs) ? (config.timeoutMs as number) : 10_000;
  const { yyyy, yyyymmdd, isoDate } = jstHeatDateParts();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(envHeatAlertUrl(yyyy, yyyymmdd), {
      method: "GET",
      headers: { "User-Agent": config.userAgent, Accept: "text/csv,text/plain" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`env heat alert 取得失敗: areaCode=${areaCode} status=${res.status}`);
    }
    const csvText: string = await res.text();
    return { parsed: parseEnvHeatAlert(areaCode, csvText), forecastDate: isoDate };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR-045: 1 校の公開 iCal/ICS を HTTP 取得しパースする（実 I/O）。`fetchWarningFromJma` に倣う（timeout /
 * 明示 User-Agent）。非 2xx・タイムアウトは throw（`runWeatherFetch` が校単位で捕捉し、天気系を巻き込まず
 * その校だけ skip する）。壊れた iCal は `parseIcs` が空 / 部分配列を返す（throw しない・fail-soft）。
 */
export async function fetchIcs(
  source: EnabledCalendarSource,
  config: HttpFetchConfig,
): Promise<FetchedCalendar> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // 非数値（NaN）は素通りで即 abort になるため、有限値でなければ既定 10s に倒す（`fetchAreaFromJma` と同じ）。
  const timeoutMs = Number.isFinite(config.timeoutMs) ? (config.timeoutMs as number) : 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(source.icsUrl, {
      method: "GET",
      headers: { "User-Agent": config.userAgent, Accept: "text/calendar,text/plain" },
      signal: controller.signal,
    });
    if (!res.ok) {
      // ★ icsUrl は PII でないがログ汚染を避けるため status のみ。
      throw new Error(`iCal 取得失敗: sourceId=${source.id} status=${res.status}`);
    }
    const text: string = await res.text();
    return { source, events: parseIcs(text) };
  } finally {
    clearTimeout(timer);
  }
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
