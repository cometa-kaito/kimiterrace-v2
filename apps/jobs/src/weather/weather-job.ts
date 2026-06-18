import { env, exit } from "node:process";
import { type RunWeatherFetchConfig, runWeatherFetchBatch } from "./run.js";

/**
 * F14 (#128, ADR-021): サイネージ天気予報の取得 Cloud Run Job エントリ。
 *
 * 使い方: `node src/weather/weather-job.ts`（Cloud Run Job のコンテナ起動コマンド）。Cloud Scheduler から
 * 30〜60 分間隔で起動する想定（JMA 更新頻度に合わせ過剰取得しない、F14 §2）。ロジックは `run.ts`
 * （`runWeatherFetchBatch` / `runWeatherFetch`、フェイクで単体検証可能）に置き、本ファイルは env 読取・
 * 構造化ログ・終了コードの I/O 結線のみに徹する（`embedding/embed-job.ts` と同じ分離）。
 *
 * 必須 env:
 * - `DATABASE_URL`: **kimiterrace_app ロール**（非 BYPASSRLS）。Secret Manager 経由で注入し、コード/
 *   コミットされる env にハードコードしない（ルール5）。
 * 任意 env:
 * - `WEATHER_FETCH_USER_AGENT`: JMA への明示 User-Agent（連絡先含む、ADR-021 §HTTP マナー）。
 *   既定は連絡先プレースホルダ付きの kimiterrace UA。
 * - `WEATHER_FETCH_TIMEOUT_MS`: HTTP タイムアウト（既定 10000）。
 *
 * ## 非スコープ（follow-up）
 * - Cloud Run Job 定義 + Cloud Scheduler + egress 許可は Terraform で管理する（ADR-009 Terraform 未作成 #94）。
 *   本 Job をスケジュール起動する配線は本スライスに含めない（未追跡 GCP インフラを作らない、ルール8）。
 * - Sentry への失敗送信（ADR-013 Sentry 未作成 #94）。現状は failed > 0 を WARN ログ + 非ゼロ終了で表現する。
 * - audit_log への取得記録（F14 §2/§4）。weather は非 PII の共有キャッシュで、行自体が「いつ取得したか」
 *   （fetched_at）の台帳になるため、ai_extractions / monthly_reports と同方針で audit_log への二重記録は
 *   別 follow-up とする（必要なら upsert に audit 同梱）。
 */

/** 必須 env を取得する（未設定は throw）。 */
function requireEnv(name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(
      `${name} が未設定です。Secret Manager / Cloud Run Job env で注入してください。`,
    );
  }
  return v;
}

/**
 * 任意の正整数 env を取得する（未設定 / 非数値 / 0 以下なら undefined → 既定にフォールバック）。
 * `raw ? Number.parseInt(...) : undefined` だと非数値で `NaN` が `timeoutMs` に流れ、`config.timeoutMs ?? 10_000`
 * は `NaN`（nullish でない）を素通しして `setTimeout(abort, NaN)` ≒ `setTimeout(abort, 0)` となり **全 fetch を
 * 即 abort** する。`Number.isFinite` で弾いて既定（10s）に倒す（tv-liveness-job と同方針）。
 */
function optionalIntEnv(name: string): number | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * エラーメッセージから接続文字列（DSN）を伏せる（ルール5: secret をログに出さない）。
 * postgres 接続エラーは host / 認証情報を message に含めうるため、URL を一律マスクする。
 */
function redactDsn(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s"]+/gi, "postgres://<redacted>");
}

async function main(): Promise<void> {
  const config: RunWeatherFetchConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    userAgent:
      env.WEATHER_FETCH_USER_AGENT ??
      "kimiterrace-weather-fetch/1.0 (+https://rebounder.jp; contact: ops@rebounder.jp)",
    // 非数値（NaN）を渡さない。未設定 / 不正なら undefined で既定（10s）に倒す（即 abort を防ぐ）。
    timeoutMs: optionalIntEnv("WEATHER_FETCH_TIMEOUT_MS"),
  };

  const summary = await runWeatherFetchBatch(config);
  // 件数サマリのみ info ログに（Cloud Logging の構造化ログ）。secret / PII は出さない。
  console.info(JSON.stringify({ event: "weather.fetch.done", summary }));

  // ADR-044: 警報相乗りの一部失敗（天気は壊さない / last-known-good 維持）も WARN を立てる。
  // 警報失敗だけで Job を fail させない（天気が取れていれば盤面は前進する）。公開の地域コードのみ。
  if (summary.warningsFailed > 0) {
    console.warn(
      JSON.stringify({
        event: "weather.warning.partial_failure",
        warningsFailed: summary.warningsFailed,
        warningsFetched: summary.warningsFetched,
        areas: summary.areas,
        warningsFailedAreaCodes: summary.warningsFailedAreaCodes,
      }),
    );
  }

  // ADR-044（3 例目）: 熱中症アラート相乗りの一部失敗（天気・警報は壊さない / last-known-good 維持）も WARN を立てる。
  // 熱中症失敗だけで Job を fail させない（天気が取れていれば盤面は前進する）。公開の地域コードのみ。
  if (summary.heatFailed > 0) {
    console.warn(
      JSON.stringify({
        event: "weather.heat.partial_failure",
        heatFailed: summary.heatFailed,
        heatFetched: summary.heatFetched,
        areas: summary.areas,
        heatFailedAreaCodes: summary.heatFailedAreaCodes,
      }),
    );
  }

  // ADR-046（5 例目）: 大気質相乗りの一部失敗（天気・警報・熱中症は壊さない / last-known-good 維持）も WARN を立てる。
  // 大気質失敗だけで Job を fail させない（天気が取れていれば盤面は前進する）。最も脆いソースなので失敗は想定内。
  if (summary.airFailed > 0) {
    console.warn(
      JSON.stringify({
        event: "weather.air.partial_failure",
        airFailed: summary.airFailed,
        airFetched: summary.airFetched,
        areas: summary.areas,
        airFailedAreaCodes: summary.airFailedAreaCodes,
      }),
    );
  }

  // ADR-045: per-school カレンダー取得の一部失敗（天気系は壊さない / last-known-good 維持）も WARN を立てる。
  // カレンダー失敗だけで Job を fail させない（天気が取れていれば盤面は前進する）。ソース id のみ（PII でない）。
  if (summary.calendarFailed > 0) {
    console.warn(
      JSON.stringify({
        event: "weather.calendar.partial_failure",
        calendarFailed: summary.calendarFailed,
        calendarFetched: summary.calendarFetched,
        calendarSources: summary.calendarSources,
        calendarFailedSourceIds: summary.calendarFailedSourceIds,
      }),
    );
  }

  // 一部地域の取得失敗（last-known-good は維持済）は WARN を立て severity ベースのアラート対象にする。
  // failedAreaCodes は公開の地域コードのみ（PII でない）。
  if (summary.failed > 0) {
    console.warn(
      JSON.stringify({
        event: "weather.fetch.partial_failure",
        failed: summary.failed,
        areas: summary.areas,
        failedAreaCodes: summary.failedAreaCodes,
      }),
    );
    // 全地域失敗（JMA 全断 / 設定不備）のみ非ゼロ終了で fail させる。部分失敗は last-known-good で
    // サイネージが壊れないため成功扱い（次サイクルで回収、冪等な upsert）。
    if (summary.fetched === 0 && summary.areas > 0) {
      exit(1);
    }
  }
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "weather.fetch.error", message }));
  exit(1);
});
