import {
  DEFAULT_TV_LIVENESS_THRESHOLDS,
  type TenantTx,
  type TvLivenessCheckSummary,
  type TvLivenessThresholds,
  createDbClient,
  runTvLivenessCheck,
  withTenantContext,
} from "@kimiterrace/db";

/**
 * F16 (ADR-023): TV 死活チェックバッチの **オーケストレーション + I/O 結線**。
 *
 * 純粋判定（閾値・遷移・原因推定 = `packages/db` の `classifyTvLiveness`）と DB 反映（`runTvLivenessCheck`）
 * を、`system_admin` context（全校横断・BYPASSRLS 不使用、ルール2）で 1 トランザクションに通す。本ファイルは
 * DB 接続の open/close と context 結線のみに徹する（`weather/run.ts` と同じ DI 分離。テストは `packages/db`
 * の純関数ユニット + 実 PG RLS テストでカバーする）。
 *
 * ## 非スコープ（follow-up）
 * - Cloud Run Job 定義 + Cloud Scheduler（1 分間隔起動）+ dead man's switch は Terraform で管理する
 *   （ルール8、ADR-009 Terraform 未作成 #94）。本 Job をスケジュール起動する配線は含めない。
 * - アラート配信（device_down / device_recovered の Sentry / メール / Slack、F16 §4）。チャネル設計 +
 *   シークレット決定が要るため別スライス。現状は遷移件数を構造化ログに残すのみ。
 */

/**
 * 任意の閾値オーバーライド（片方だけ指定もあり得る）から完全な `TvLivenessThresholds` を組む純関数。
 * 未指定（undefined）は既定（3 分 / OFF 時 30 分）にフォールバックする。entrypoint の env 読取結果を
 * 受けて確定値を作る seam（DB 非依存で単体テスト可能）。
 */
export function resolveThresholds(overrides?: Partial<TvLivenessThresholds>): TvLivenessThresholds {
  return {
    downThresholdSec:
      overrides?.downThresholdSec ?? DEFAULT_TV_LIVENESS_THRESHOLDS.downThresholdSec,
    offHoursThresholdSec:
      overrides?.offHoursThresholdSec ?? DEFAULT_TV_LIVENESS_THRESHOLDS.offHoursThresholdSec,
  };
}

/** 実行時の設定（DB 接続 + 閾値。DATABASE_URL は Secret Manager 経由、ルール5）。 */
export interface RunTvLivenessConfig {
  /** DB 接続文字列（kimiterrace_app ロール、非 BYPASSRLS）。Secret Manager 経由で注入（ルール5）。 */
  databaseUrl: string;
  /** down 閾値（環境変数由来、F16 §6）。省略時は既定（3 分 / OFF 時 30 分）。 */
  thresholds?: TvLivenessThresholds;
  /** 判定基準時刻。省略時は実行時の `new Date()`（テストで固定値を注入できる）。 */
  now?: Date;
  /** テスト用: BYPASSRLS 接続をアプリロールへ降格する SET LOCAL ROLE 先。本番は未指定。 */
  appRole?: string;
}

/**
 * 実 PG で TV 死活チェックを 1 回実行する。接続は本関数が開き、終了時に必ず閉じる。
 * env 読取・プロセス終了コードは entrypoint（`tv-liveness-job.ts`）が担う（`weather/run.ts` と同じ分離）。
 *
 * チェッカは全校横断で down/recover を走査するため `system_admin` context で実行する
 * （`system_admin_full_access` policy、ルール2）。
 */
export async function runTvLivenessCheckBatch(
  config: RunTvLivenessConfig,
): Promise<TvLivenessCheckSummary> {
  const { sql, db } = createDbClient(config.databaseUrl);
  const appRoleOptions = config.appRole !== undefined ? { appRole: config.appRole } : {};
  const thresholds = config.thresholds ?? DEFAULT_TV_LIVENESS_THRESHOLDS;
  const now = config.now ?? new Date();
  try {
    return await withTenantContext(
      db,
      { role: "system_admin" },
      (tx: TenantTx) => runTvLivenessCheck(tx, now, thresholds),
      appRoleOptions,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
