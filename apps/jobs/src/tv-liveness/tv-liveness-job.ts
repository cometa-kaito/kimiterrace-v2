import { env, exit } from "node:process";
import { type RunTvLivenessConfig, resolveThresholds, runTvLivenessCheckBatch } from "./run.js";

/**
 * F16 (ADR-023): TV 死活チェックの Cloud Run Job エントリ。
 *
 * 使い方: `node src/tv-liveness/tv-liveness-job.ts`（Cloud Run Job のコンテナ起動コマンド）。Cloud Scheduler
 * から **1 分間隔** で起動する想定（ADR-023 / F16 §2）。ロジックは `run.ts`（`runTvLivenessCheckBatch`、
 * フェイク無しでも実 PG で検証可能）と `packages/db` の純関数（`classifyTvLiveness`）に置き、本ファイルは
 * env 読取・構造化ログ・終了コードの I/O 結線のみに徹する（`weather/weather-job.ts` と同じ分離）。
 *
 * 必須 env:
 * - `DATABASE_URL`: **kimiterrace_app ロール**（非 BYPASSRLS）。Secret Manager 経由で注入し、コード/
 *   コミットされる env にハードコードしない（ルール5）。
 * 任意 env:
 * - `TV_DOWN_THRESHOLD_SEC`: 通常の down 閾値（秒、既定 180 = 3 分）。
 * - `TV_OFF_HOURS_THRESHOLD_SEC`: OFF 時間帯の緩い閾値（秒、既定 1800 = 30 分）。
 *
 * ## 非スコープ（follow-up）
 * - Cloud Run Job 定義 + Cloud Scheduler（1 分間隔）+ dead man's switch（チェッカ自体の死活、ADR-014）は
 *   Terraform で管理する（ルール8、ADR-009 未作成 #94）。本 Job をスケジュール起動する配線は含めない。
 * - アラート配信（Sentry / メール / Slack、F16 §4）。現状は遷移件数を INFO ログに残すのみ。
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

/** 任意の整数 env を取得する（未設定/不正なら undefined → 既定にフォールバック）。 */
function optionalIntEnv(name: string): number | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * エラーメッセージから接続文字列（DSN）を伏せる（ルール5: secret をログに出さない）。
 */
function redactDsn(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s"]+/gi, "postgres://<redacted>");
}

async function main(): Promise<void> {
  // 片方だけ指定もあり得るため、指定があるものだけ上書きする（未指定は既定が効く）。閾値の確定は
  // resolveThresholds（純関数 seam）に委ね、env 読取だけここで行う。
  const config: RunTvLivenessConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    thresholds: resolveThresholds({
      downThresholdSec: optionalIntEnv("TV_DOWN_THRESHOLD_SEC"),
      offHoursThresholdSec: optionalIntEnv("TV_OFF_HOURS_THRESHOLD_SEC"),
    }),
  };

  const summary = await runTvLivenessCheckBatch(config);
  // 件数サマリのみ info ログに（Cloud Logging の構造化ログ）。secret / PII は出さない。
  console.info(JSON.stringify({ event: "tv.health_check.done", summary }));
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "tv.health_check.error", message }));
  exit(1);
});
