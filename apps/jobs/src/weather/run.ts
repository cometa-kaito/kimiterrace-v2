import {
  type NormalizedWarning,
  type TenantTx,
  createDbClient,
  listSchools,
  resolveJmaAreaCode,
  upsertWeatherForecast,
  upsertWeatherWarning,
  withTenantContext,
} from "@kimiterrace/db";
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
 * `runWeatherFetch` の依存（fetch / DB を注入してネットワーク・DB なしで検証可能にする）。
 * 警報（ADR-044 相乗り）の `fetchWarning` / `saveWarning` は **任意**。未指定なら警報取得を skip する
 * （既存の天気のみのテスト・呼び出し側を壊さない後方互換）。
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
 */
export async function runWeatherFetch(deps: WeatherFetchDeps): Promise<WeatherFetchSummary> {
  const areaCodes = await deps.listAreaCodes();
  let fetched = 0;
  let rowsUpserted = 0;
  const failedAreaCodes: string[] = [];
  let warningsFetched = 0;
  const warningsFailedAreaCodes: string[] = [];
  const warningsEnabled = deps.fetchWarning != null && deps.saveWarning != null;

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
