import { env, exit } from "node:process";
import { type RunRailwayFetchConfig, runRailwayFetchBatch } from "./run.js";

/**
 * パターン2「鉄道」運行情報の取得 Cloud Run Job エントリ（ADR-035）。
 *
 * 使い方: `node src/railway-status/railway-status-job.js`（Cloud Run Job のコンテナ起動コマンド）。
 * Cloud Scheduler から数分間隔で起動する想定（過剰取得しない・名鉄サイトへの礼儀、ADR-035）。ロジックは
 * `run.ts`（`runRailwayFetchBatch`、フェイクで単体検証可能）に置き、本ファイルは env 読取・構造化ログ・終了
 * コードの I/O 結線のみに徹する（weather-job.ts と同じ分離）。
 *
 * 必須 env:
 * - `DATABASE_URL`: **kimiterrace_app ロール**（非 BYPASSRLS）。Secret Manager 経由で注入（ルール5）。
 * 任意 env:
 * - `RAILWAY_FETCH_USER_AGENT`: 名鉄への明示 User-Agent（連絡先含む）。
 * - `RAILWAY_FETCH_TIMEOUT_MS`: HTTP タイムアウト（既定 10000）。
 * - `RAILWAY_STATUS_URL`: 取得元 URL（既定は名鉄運行情報ページ。テスト/将来差替え用）。
 *
 * ## fail-soft
 * 取得失敗・パース不能は last-known-good を維持（既存キャッシュを消さない）。**正常に skip した場合は終了
 * コード 0**（盤面は前回値で壊れない）。設定不備（DATABASE_URL 未設定）等のみ非ゼロ終了。
 */

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

/** エラーメッセージから接続文字列（DSN）を伏せる（ルール5: secret をログに出さない）。 */
function redactDsn(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s"]+/gi, "postgres://<redacted>");
}

async function main(): Promise<void> {
  const config: RunRailwayFetchConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    userAgent:
      env.RAILWAY_FETCH_USER_AGENT ??
      "kimiterrace-railway-fetch/1.0 (+https://rebounder.jp; contact: ops@rebounder.jp)",
    // 非数値（NaN）を渡さない。未設定 / 不正なら undefined で既定（10s）に倒す（即 abort を防ぐ）。
    timeoutMs: optionalIntEnv("RAILWAY_FETCH_TIMEOUT_MS"),
    ...(env.RAILWAY_STATUS_URL ? { url: env.RAILWAY_STATUS_URL } : {}),
  };

  const summary = await runRailwayFetchBatch(config);
  // サマリのみ info ログ（Cloud Logging の構造化ログ）。secret / PII は出さない。
  console.info(JSON.stringify({ event: "railway.fetch.done", summary }));

  // 取得失敗・パース不能（last-known-good 維持）は WARN を立てるが、盤面は前回値で壊れないため成功扱い
  // （次サイクルで回収。冪等な upsert）。終了コードは 0 のまま。
  if (summary.skippedReason) {
    console.warn(JSON.stringify({ event: "railway.fetch.skipped", reason: summary.skippedReason }));
  }
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "railway.fetch.error", message }));
  exit(1);
});
