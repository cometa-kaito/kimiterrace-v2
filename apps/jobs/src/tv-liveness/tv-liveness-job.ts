import { env, exit } from "node:process";
import { deliverTvWakeOnDown } from "./fcm.js";
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
 * ## ON 時間帯のタイト監視（F16 §9） + スケジュール OFF 時間帯のスキップ（運営整理 BUG-2）
 * TV は ON 時間帯は黒画面のまま 60 秒ポーリングを続ける（スリープしない）ため、**ON 中の無音 = 実障害**。よって
 * ON 時間帯には **単一のタイト閾値 ≈120 秒**（= 60 秒ポーリング 2 回欠落、瞬断耐性あり）を適用する。
 * 本エントリで `{ downThresholdSec: 120, offHoursThresholdSec: 120 }` を渡す。
 *
 * 一方で **スケジュール OFF 時間帯は死活評価そのものをスキップする**（`classifyTvLiveness` が
 * `isSignageOffHours` で `continue`、`tv-liveness.ts`）。OFF 中の黒画面は正常で応答なしに数えない（運営整理
 * BUG-2: 正常な OFF と復帰不能の応答なしを区別する）。復帰不能の本当の応答なしは、ON 時間帯に入って
 * downThreshold を超えた時点で検出される。**したがって「24/7 連続のハードダウン検知」ではなく、各端末の ON
 * 時間帯内でのみタイト監視が効く**（OFF 中に死んだ端末は次の ON で検出。scheduleJson が NULL の端末は常時 ON
 * 扱いで全時間帯監視）。`offHoursThresholdSec` は現状この OFF スキップにより未使用（後方互換で受けるのみ）。
 * env `TV_DOWN_THRESHOLD_SEC` / `TV_OFF_HOURS_THRESHOLD_SEC` での上書きは引き続き可能だが、既定を 120/120 に倒す。
 *
 * ## 遠隔起動（F16 拡張）
 * 上記 down エッジ（`downDevices`）の各端末に `fcm_token` があれば FCM HTTP v1 で `data.action=wake` を送り、
 * 端末の常駐サービスを起こし直す（fcm.ts の `deliverTvWakeOnDown` → `@kimiterrace/fcm`）。OAuth は ADC /
 * Workload Identity（鍵ファイル禁止、ルール5）。送信先プロジェクトは `GCP_PROJECT_ID` env（無ければ
 * no-op）。送信失敗で Job は落とさない（Slack と同じ可用性規律）。
 *
 * 必須 env:
 * - `DATABASE_URL`: **kimiterrace_app ロール**（非 BYPASSRLS）。Secret Manager 経由で注入し、コード/
 *   コミットされる env にハードコードしない（ルール5）。
 * 任意 env:
 * - `GCP_PROJECT_ID`（無ければ `GOOGLE_CLOUD_PROJECT`）: FCM 送信先 Firebase プロジェクト（公開値＝非 secret、
 *   Cloud Run module が注入済）。未設定なら遠隔起動は no-op（件数ログのみ）。
 * - `SLACK_WEBHOOK_URL`: Slack Incoming Webhook（Secret Manager 経由）。未設定なら配信 no-op（ルール5）。
 * - `TV_LIVENESS_HEARTBEAT`: "1"/"true" のとき日次ハートビート（✅ 監視稼働中）を 1 件足す（dead-man's-switch）。
 *   毎分起動でこれを常時立てるとスパムになるため、日次起動の Scheduler でのみ立てる想定。
 * - `TV_ALERT_ON_RECOVERY`: "1"/"true" のとき復帰(🟢)も Slack 通知する。**既定 false = 立ち下がり down(🔴)
 *   のみ通知**（F16 §9）。down→ok の状態遷移は checker が記録するため、🟢 抑制でも down エッジは正しく発火。
 *   長時間サイレンスの復帰（🟢 サイレンス復帰）も同じ flag で opt-in する。
 * - `TV_DOWN_THRESHOLD_SEC`: down 閾値（秒、既定 120 = 24/7 タイト）。
 * - `TV_OFF_HOURS_THRESHOLD_SEC`: OFF 時間帯の閾値（秒、既定 120 = 緩和撤廃で通常と同値）。
 * - `TV_LONG_SILENCE_SEC`: 長時間サイレンス閾値（秒、既定 21600 = 6h）。
 *
 * ## 長時間サイレンス（schedule-agnostic）— OFF 時間帯の死活盲点 修正
 * 上記 down/recover は OFF 時間帯（黒画面）の死活評価を **スキップ**する（BUG-2: 正常な OFF を誤報しない）。
 * これは意図的だが、副作用として **OFF 中に本当に死んだ端末を隠す**（夜間 ~03:47→07:00 の途絶が ON 入りで
 * 自己復帰扱いになり記録すらされず、慢性故障がマスクされる）。これを補うため、**schedule を一切見ない**別
 * シグナル「長時間サイレンス」（`classifyLongSilence`, `packages/db`）を同じチェッカで走らせる。`now - last_seen`
 * が `TV_LONG_SILENCE_SEC`（既定 6h）を超えた端末を ⚠️ で 1 回だけ通知（send-once は `tv_devices.
 * long_silence_notified_at` 列で dedup）。**6h が安全な理由**: 全端末は 24h 通電で OFF 中も ~60 秒ポーリングを
 * 続ける（運用上の確定事実）。正常な無音ギャップは瞬断・1〜2 回欠落止まりで 6h には決して届かないため、OFF
 * 時間帯でも 6h の長時間サイレンスは正常な黒画面 OFF では起こらず、BUG-2 型の誤報を再発させない。down/recover
 * の `tv_device_downtime` 行は作らない（運用ダウンタイム表を汚さない＝dedup 列だけが persistence）。
 *
 * ## 非スコープ（follow-up）
 * - Cloud Run Job 定義 + Cloud Scheduler（毎分化）+ Slack シークレットコンテナは Terraform で管理する
 *   （ルール8）。本 Job をスケジュール起動する配線・シークレット定義はここには含めない（FCM 送信 SA 権限の
 *   Terraform 化は本機能の PR に同梱する）。
 * - Sentry / メール配信（F16 §4）。本 Job は Slack 配信 + FCM 遠隔起動。
 * - **非スコープ note**: 既存の down/recover OFF スキップが使う `isSignageOffHours` は本ブランチ時点で既に
 *   `schedule_windows`（複数ウィンドウ / 分単位）形状を解釈する。長時間サイレンス検出器はそもそも
 *   schedule-agnostic（`isSignageOffHours` を呼ばない）なので、マルチウィンドウ同期の影響を受けない。
 *   よって本 PR では isSignageOffHours / down-recover OFF スキップには一切手を入れない（別シグナルのまま）。
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
  // ON 時間帯のタイト監視（F16 §9）: 既定を 120/120 に倒す。env 指定があればそれを優先する（運用での微調整
  // 余地は残す）。なお `classifyTvLiveness` はスケジュール OFF 時間帯を `isSignageOffHours` でスキップする
  // （運営整理 BUG-2）ため、この閾値が効くのは各端末の ON 時間帯内のみ（OFF 中のハードダウンは次の ON で
  // 検出）。閾値の確定は resolveThresholds（純関数 seam）に委ね、env 読取だけここで行う。
  const now = new Date();
  const config: RunTvLivenessConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    now,
    thresholds: resolveThresholds({
      downThresholdSec: optionalIntEnv("TV_DOWN_THRESHOLD_SEC") ?? TIGHT_THRESHOLD_SEC,
      offHoursThresholdSec: optionalIntEnv("TV_OFF_HOURS_THRESHOLD_SEC") ?? TIGHT_THRESHOLD_SEC,
    }),
    // 長時間サイレンス閾値（schedule-agnostic 別シグナル）。未指定なら DB 層の既定（6h）にフォールバック。
    longSilenceSec: optionalIntEnv("TV_LONG_SILENCE_SEC"),
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
        newlyLongSilent: summary.newlyLongSilent,
        longSilenceCleared: summary.longSilenceCleared,
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

  // 遠隔起動（F16 拡張）: down エッジの各端末に fcm_token があれば FCM wake を送り常駐サービスを起こし直す。
  // GCP_PROJECT_ID 未設定なら no-op（件数ログのみ）。送信失敗で Job は落とさない（Slack と同じ可用性規律）。
  // Slack 通知（人への可視化）と FCM 起動（端末の自動復旧）は独立した副作用ゆえ順に実行する。
  await deliverTvWakeOnDown(summary);
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "tv.health_check.error", message }));
  exit(1);
});
