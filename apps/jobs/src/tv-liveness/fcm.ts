import { env } from "node:process";
import type { TvLivenessCheckSummary } from "@kimiterrace/db";
import {
  type FcmSender,
  canSendWake,
  createGoogleAuthFcmSender,
  sendWakeToToken,
} from "@kimiterrace/fcm";

/**
 * F16 拡張（遠隔起動）: TV 死活の **down エッジ → FCM wake 送信**の結線層。
 *
 * 死活チェッカ（`packages/db` の `runTvLivenessCheck`）が出す up→down 反転エッジ（`downDevices`）の各端末に、
 * `fcm_token` があれば FCM HTTP v1 で `data.action=wake` を送り、端末の常駐サービスを起こし直す
 * （端末アプリ tv-bridge はどんな FCM メッセージでも起動し直す）。Slack 配信（slack.ts）と同じ
 * 「純関数 + 薄い副作用アダプタ（`@kimiterrace/fcm`）」分離で、本ファイルは env 読取・送信可否・件数ログの
 * 結線のみに徹する（FCM 送信本体は `@kimiterrace/fcm` で単体テスト済）。
 *
 * ## エッジ 1 回だけ（Slack と同じ送信規律）
 * `downDevices` は状態機械が **新規 down に反転した端末だけ**を積む（down→down 継続は no-op）。本層はそれを
 * そのまま 1 件 1 送信するだけで、既に down 中の端末を再度起こさない（多重 wake 防止は state machine 側に委ねる）。
 *
 * ## 認証・宛先プロジェクト（ルール5）
 * 送信先 Firebase プロジェクトは `GCP_PROJECT_ID`（無ければ `GOOGLE_CLOUD_PROJECT`）env から読む（公開値＝非
 * secret）。OAuth は `@kimiterrace/fcm` が ADC / Workload Identity で解決（鍵ファイル禁止）。**project 未設定なら
 * 送信は no-op**（ログのみ）で Job / CI は緑のまま回る（Slack URL 未設定時の no-op と同規律）。
 *
 * ## 可用性規律
 * FCM 送信失敗（非 2xx / 例外）で死活 Job 自体を落とさない。`@kimiterrace/fcm` の `send` は throw せず結果を返し、
 * 本層はそれを集計してログするだけ。死活検出（DB 反映）は既に commit 済みであり、遠隔起動の失敗が検出を巻き戻しては
 * ならない。
 *
 * ## PII 非含み（ルール4）/ secret 非ログ（ルール5）
 * ログに載せるのは件数・成否のみ。FCM トークン（payload / レスポンス本文）と device ラベルは出さない。
 */

/**
 * FCM 送信先プロジェクト ID を読む。`GCP_PROJECT_ID` を優先し、未設定/空（trim 後）なら
 * `GOOGLE_CLOUD_PROJECT` にフォールバックする。どちらも空なら null（= 送信 no-op）。
 * 空文字も「未設定」扱いにするため `??` ではなく trim 後の非空判定でフォールバックする
 * （空 env が誤ってフォールバックを潰さないように）。
 */
export function getFcmProjectId(): string | null {
  const primary = env.GCP_PROJECT_ID?.trim();
  if (primary) return primary;
  const fallback = env.GOOGLE_CLOUD_PROJECT?.trim();
  return fallback ? fallback : null;
}

/**
 * down エッジの各端末に wake を送る。`sender` が未指定なら GCP_PROJECT_ID から実 sender を作る
 * （ADC = 鍵不要）。project 未設定なら no-op（送信すべきだった件数だけ info ログ）。テストは `sender` を
 * 注入してネットワークなしで件数分岐を検証できる。
 *
 * @param summary  チェッカ集計（`downDevices` に各端末の fcmToken が載る）。
 * @param sender   FCM 送信アダプタ（テスト用注入。未指定なら GoogleAuth + project env から生成）。
 */
export async function deliverTvWakeOnDown(
  summary: TvLivenessCheckSummary,
  sender?: FcmSender,
): Promise<void> {
  // 送信対象（fcm_token あり）の down 端末だけ抽出する。0 件なら sender 生成も認証も走らせない。
  const targets = summary.downDevices.filter((d) => canSendWake(d.fcmToken));
  if (targets.length === 0) {
    return;
  }

  const resolvedSender = sender ?? buildSenderFromEnv();
  if (resolvedSender === null) {
    // project 未設定（CI / 未設定環境）。送信せず、送信すべきだった件数だけ可視化（PII / token 非含み）。
    // biome-ignore lint/suspicious/noConsole: Cloud Run Job の構造化運用ログ（Cloud Logging へ出力）。
    console.info(
      JSON.stringify({
        event: "tv.health_check.fcm_skipped",
        reason: "GCP_PROJECT_ID unset",
        wakeTargets: targets.length,
      }),
    );
    return;
  }

  let sent = 0;
  let failed = 0;
  // 順次送る（件数は通常 0〜数件で並列化不要）。各送信は throw しない（失敗は集計してログ）。
  for (const device of targets) {
    const res = await sendWakeToToken(resolvedSender, device.fcmToken);
    if (res.ok) {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  // 件数・成否のみログ（token / label は出さない、ルール4/5）。
  // biome-ignore lint/suspicious/noConsole: Cloud Run Job の構造化運用ログ（Cloud Logging へ出力）。
  console.info(
    JSON.stringify({
      event: "tv.health_check.fcm_wake",
      wakeTargets: targets.length,
      sent,
      failed,
    }),
  );
}

/** GCP_PROJECT_ID から実 sender（ADC）を作る。未設定なら null（送信 no-op）。 */
function buildSenderFromEnv(): FcmSender | null {
  const projectId = getFcmProjectId();
  if (projectId === null) {
    return null;
  }
  return createGoogleAuthFcmSender({ projectId });
}
