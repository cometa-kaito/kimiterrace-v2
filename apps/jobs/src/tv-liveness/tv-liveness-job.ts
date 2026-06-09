import { env, exit } from "node:process";
import { type RunTvLivenessConfig, resolveThresholds, runTvLivenessCheckBatch } from "./run.js";
import { deliverTvLivenessAlerts } from "./slack.js";

/**
 * F16 (ADR-023, §9): TV 死活チェックの Cloud Run Job エントリ。
 *
 * 使い方: `node src/tv-liveness/tv-liveness-job.ts`（Cloud Run Job のコンテナ起動コマンド）。Cloud Scheduler
 * から **1 分間隔** で起動する想定（ADR-023 / F16 §2）。ロジックは `run.ts`（`runTvLivenessCheckBatch`、
 * フェイク無しでも実 PG で検証可能）と `packages/db` の純関数（`classifyTvLiveness`）に置き、本ファイルは
 * env 読取・構造化ログ・Slack 配信結線・終了コードの I/O 結線のみに徹する（`weather/weather-job.ts` と同じ分離）。
 *
 * ## 24/7 タイト監視（F16 §9、OFF 時間帯緩和の撤廃）
 * TV は夜間も黒画面のまま 60 秒ポーリングを続ける（スリープしない）ため、**夜間の無音 = 実障害**。よって
 * OFF 時間帯に閾値を緩める旧仕様（30 分）を撤廃し、**24/7 単一のタイト閾値 ≈120 秒**（= 60 秒ポーリング 2 回
 * 欠落、瞬断耐性あり）を適用する。実装は本エントリで `{ downThresholdSec: 120, offHoursThresholdSec: 120 }`
 * を渡し、純判定側（`classifyTvLiveness` の `isStale`）が OFF 時間帯でも同じ閾値を使うようにする
 * （`tv-liveness.ts` に OFF 時間帯の「アラート skip」分岐は無く、閾値を揃えれば緩和は完全に消える）。
 * env `TV_DOWN_THRESHOLD_SEC` / `TV_OFF_HOURS_THRESHOLD_SEC` での上書きは引き続き可能だが、既定を 120/120 に倒す。
 *
 * 必須 env:
 * - `DATABASE_URL`: **kimiterrace_app ロール**（非 BYPASSRLS）。Secret Manager 経由で注入し、コード/
 *   コミットされる env にハードコードしない（ルール5）。
 * 任意 env:
 * - `SLACK_WEBHOOK_URL`: Slack Incoming Webhook（Secret Manager 経由）。未設定なら配信 no-op（ルール5）。
 * - `TV_LIVENESS_HEARTBEAT`: "1"/"true" のとき日次ハートビート（✅ 監視稼働中）を 1 件足す（dead-man's-switch）。
 *   毎分起動でこれを常時立てるとスパムになるため、日次起動の Scheduler でのみ立てる想定。
 * - `TV_ALERT_ON_RECOVERY`: "1"/"true" のとき復帰(🟢)も Slack 通知する。**既定 false = 立ち下がり down(🔴)
 *   のみ通知**（F16 §9）。down→ok の状態遷移は checker が記録するため、🟢 抑制でも down エッジは正しく発火。
 * - `TV_DOWN_THRESHOLD_SEC`: down 閾値（秒、既定 120 = 24/7 タイト）。
 * - `TV_OFF_HOURS_THRESHOLD_SEC`: OFF 時間帯の閾値（秒、既定 120 = 緩和撤廃で通常と同値）。
 *
 * ## 非スコープ（follow-up）
 * - Cloud Run Job 定義 + Cloud Scheduler（毎分化）+ Slack シークレットコンテナは Terraform で管理する
 *   （ルール8、別 PR）。本 Job をスケジュール起動する配線・シークレット定義は含めない。
 * - Sentry / メール配信（F16 §4）。本 PR は Slack 配信のみ。
 */

/** 24/7 タイト監視の既定閾値（秒）。OFF 緩和を撤廃し通常/OFF を同値に揃える（F16 §9）。 */
const TIGHT_THRESHOLD_SEC = 120;

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

/** 真偽 env を取得する（"1"/"true"（大小無視）のみ true、それ以外/未設定は false）。 */
function boolEnv(name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * エラーメッセージから接続文字列（DSN）を伏せる（ルール5: secret をログに出さない）。
 */
function redactDsn(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s"]+/gi, "postgres://<redacted>");
}

async function main(): Promise<void> {
  // 24/7 タイト監視（F16 §9）: 既定を 120/120 に倒し OFF 緩和を撤廃する。env 指定があればそれを優先する
  // （運用での微調整余地は残す）。通常 / OFF を同値に揃えることで `isStale` が OFF 時間帯でも同じ閾値を使い、
  // 緩和は完全に消える（`tv-liveness.ts` 側に OFF 時間帯のアラート skip 分岐は無い）。閾値の確定は
  // resolveThresholds（純関数 seam）に委ね、env 読取だけここで行う。
  const now = new Date();
  const config: RunTvLivenessConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    now,
    thresholds: resolveThresholds({
      downThresholdSec: optionalIntEnv("TV_DOWN_THRESHOLD_SEC") ?? TIGHT_THRESHOLD_SEC,
      offHoursThresholdSec: optionalIntEnv("TV_OFF_HOURS_THRESHOLD_SEC") ?? TIGHT_THRESHOLD_SEC,
    }),
  };

  const summary = await runTvLivenessCheckBatch(config);
  // 件数サマリのみ info ログに（Cloud Logging の構造化ログ）。secret / PII は出さない（label は教室名で非 PII）。
  console.info(
    JSON.stringify({
      event: "tv.health_check.done",
      summary: {
        scanned: summary.scanned,
        newlyDown: summary.newlyDown,
        recovered: summary.recovered,
      },
    }),
  );

  // state 反転エッジを Slack へ配信する。**既定は立ち下がり down(🔴) のみ**通知（F16 §9・運用方針。
  // TV_ALERT_ON_RECOVERY=1 で復帰🟢 も opt-in）。env flag が立っていれば日次ハートビートを足す。
  // SLACK_WEBHOOK_URL 未設定なら no-op（CI / 未注入環境でも緑、ルール5）。配信失敗で Job は落とさない。
  await deliverTvLivenessAlerts(
    summary,
    now,
    boolEnv("TV_LIVENESS_HEARTBEAT"),
    boolEnv("TV_ALERT_ON_RECOVERY"),
  );
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "tv.health_check.error", message }));
  exit(1);
});
