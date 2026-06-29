import { env } from "node:process";
import type { TvLivenessCheckSummary } from "@kimiterrace/db";

/**
 * F16 (ADR-023, §4/§9): TV 死活の **Slack 配信アダプタ + 純フォーマッタ**。
 *
 * 死活チェッカ（`packages/db` の `runTvLivenessCheck`）が出す state 反転エッジ（`downDevices` /
 * `recoveredDevices`）を Slack Incoming Webhook に流す薄い層。設計方針は `weather` ジョブと同じく
 * 「純関数（フォーマッタ）を単体テスト + 副作用（POST）は薄いアダプタで吸収」。
 *
 * ## エッジ 1 回だけ通知（send-once）
 * チェッカの状態機械が「新規 down に反転した TV だけ」を `downDevices`、「復帰した TV だけ」を
 * `recoveredDevices` に積む（down→down 継続は no-op）。本層はそれをそのまま 1 件 1 POST するだけで、
 * 既に down 中の TV を再通知しない（多重通知防止は state machine 側に委ねる）。
 * **既定では down(🔴) のみ配信し、復帰(🟢) は送らない**（F16 §9: 立ち下がりのみ通知する運用方針。
 * `alert_state` の down→ok 遷移自体は checker が DB に記録するため、🟢 を抑制しても次の down エッジは
 * 正しく発火する。`TV_ALERT_ON_RECOVERY=1` で復帰通知を opt-in できる）。
 *
 * ## シークレット規律（ルール5）
 * Webhook URL は `SLACK_WEBHOOK_URL` env からのみ読む（Secret Manager 経由で Cloud Run Job に注入）。
 * コード/コミットにハードコードしない。**未設定なら配信は no-op**（ログのみ）で Job / CI は緑のまま回り、
 * URL は後追いで注入される（PR6 のシークレットコンテナ + scheduler 毎分化は別 PR）。
 *
 * ## 可用性規律
 * Slack 障害（5xx / タイムアウト）で死活 Job 自体を落とさない。`postSlack` は非 200 を **ログするだけで
 * throw しない**。死活検出（DB 反映）は既に commit 済みであり、通知の失敗が検出を巻き戻してはならない。
 *
 * ## PII 非含み（ルール4 / F16 §5）
 * 通知文に載るのは device ラベル（教室名等、PII 非含みの自由文字列）・学校 ID・時刻・経過分のみ。
 * 生徒/保護者情報は一切含めない。
 */

/** Slack 通知 1 件分の device 情報（down エッジ）。summary の inline 要素型を再利用する。 */
type DownDevice = TvLivenessCheckSummary["downDevices"][number];
/** Slack 通知 1 件分の device 情報（recover エッジ）。 */
type RecoveredDevice = TvLivenessCheckSummary["recoveredDevices"][number];
/** Slack 通知 1 件分の device 情報（長時間サイレンス エッジ）。 */
type LongSilentDevice = TvLivenessCheckSummary["longSilentDevices"][number];
/** Slack 通知 1 件分の device 情報（長時間サイレンス クリア エッジ）。 */
type LongSilenceClearedDevice = TvLivenessCheckSummary["longSilenceClearedDevices"][number];

/** ラベル未設定 TV のフォールバック表示（device_id 先頭で判別可能にする）。 */
function deviceLabel(device: { label: string | null; deviceId: string }): string {
  const trimmed = device.label?.trim();
  if (trimmed) return trimmed;
  // ラベル未設定でも識別できるよう device_id の先頭 8 文字を出す（全長は推測不能トークンなので伏せる）。
  return `(ラベル未設定 ${device.deviceId.slice(0, 8)})`;
}

/**
 * `now - lastSeenAt` の経過分（切り捨て、非負）を返す純関数。`lastSeenAt===null`（未観測）は null。
 * 通知文で「何分前から無応答か」を示す。
 */
export function minutesSince(lastSeenAt: Date | null, now: Date): number | null {
  if (lastSeenAt === null) return null;
  const diffMs = now.getTime() - lastSeenAt.getTime();
  return Math.max(0, Math.floor(diffMs / 60_000));
}

/**
 * 🔴 ダウン検知メッセージ（純関数）。device ラベル・学校・最終観測時刻・経過分を 1 行に組む。
 * `lastSeenAt===null` のときは経過分を出さず「最終観測: なし」とする。
 */
export function formatTvDownMessage(device: DownDevice, now: Date): string {
  const mins = minutesSince(device.lastSeenAt, now);
  const lastSeen =
    device.lastSeenAt === null ? "最終観測: なし" : `最終観測: ${device.lastSeenAt.toISOString()}`;
  const since = mins === null ? "" : `（${mins}分間 無応答）`;
  return `🔴 TV無応答: ${deviceLabel(device)} / 学校 ${device.schoolId} / ${lastSeen}${since}`;
}

/**
 * 🟢 復帰メッセージ（純関数）。down→up に反転した TV を 1 行で示す。
 */
export function formatTvRecoveredMessage(device: RecoveredDevice): string {
  const lastSeen =
    device.lastSeenAt === null ? "最終観測: なし" : `最終観測: ${device.lastSeenAt.toISOString()}`;
  return `🟢 TV復帰: ${deviceLabel(device)} / 学校 ${device.schoolId} / ${lastSeen}`;
}

/**
 * `now - lastSeenAt` の経過時間を「時間」（小数1桁、非負）で返す純関数。長時間サイレンス通知で「何時間
 * 無応答か」を示す。長時間サイレンスは lastSeenAt 必須（summary 側で Date 確定）なので null を取らない。
 */
export function hoursSince(lastSeenAt: Date, now: Date): number {
  const diffMs = now.getTime() - lastSeenAt.getTime();
  return Math.max(0, Math.round(diffMs / 360_000) / 10); // 0.1h 単位に丸める
}

/**
 * ⚠️ 長時間サイレンス メッセージ（純関数）。**down(🔴) とは別シグナル**で、消灯中（OFF）でも 24/7
 * ポーリングが本来継続するはずの端末が長時間（既定 6h）無応答 = 慢性故障の疑い、を 1 行で示す。
 * 「消灯中でも本来ポーリング継続のはず＝要確認」を明記して、正常な黒画面 OFF と取り違えないよう促す。
 */
export function formatTvLongSilenceMessage(device: LongSilentDevice, now: Date): string {
  const hours = hoursSince(device.lastSeenAt, now);
  return `⚠️ 長時間サイレンス: ${deviceLabel(device)} / 学校 ${device.schoolId} が ${hours}h 無応答（消灯中でも本来ポーリング継続のはず＝要確認）`;
}

/**
 * 🟢 長時間サイレンス復帰メッセージ（純関数）。dedup 列が NULL に戻った（鮮度復帰した）TV を 1 行で示す。
 * 既定では送らず、復帰通知 opt-in（down/recover の 🟢 と同じ gate）が立っている時のみ配信する。
 */
export function formatTvLongSilenceClearedMessage(device: LongSilenceClearedDevice): string {
  const lastSeen =
    device.lastSeenAt === null ? "最終観測: なし" : `最終観測: ${device.lastSeenAt.toISOString()}`;
  return `🟢 サイレンス復帰: ${deviceLabel(device)} / 学校 ${device.schoolId} / ${lastSeen}`;
}

/**
 * ✅ 日次ハートビート（dead-man's-switch）メッセージ（純関数）。**チェッカ自体が生きている**ことを示すのが
 * 主目的（✅ が届かなくなったら監視プロセスの死を疑う）。数値は「今回サイクルで新規 down 検出した台数」で
 * あり、標準の「現在継続 down 中の台数」ではない点に注意（継続 down 数は summary に持たないため）。
 */
export function formatHeartbeatMessage(summary: TvLivenessCheckSummary): string {
  return `✅ TV監視稼働中 / 今回新規down ${summary.newlyDown}台`;
}

/**
 * `SLACK_WEBHOOK_URL` env を読む。未設定/空（trim 後）なら null（= 配信 no-op）。
 * URL の中身（トークン）はログに出さない（ルール5）。
 */
export function getSlackWebhookUrl(): string | null {
  const raw = env.SLACK_WEBHOOK_URL?.trim();
  return raw ? raw : null;
}

/**
 * Slack Incoming Webhook に `{ text }` を POST する薄いアダプタ。**非 200 でも throw しない**
 * （Slack 障害が死活 Job を落とさない）。グローバル `fetch` を使う（Node 20+ / undici）。
 * URL はログに出さない（トークンを含むため、ルール5）。
 */
export async function postSlack(webhookUrl: string, text: string): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      // 非 200 はログのみ（再試行しない・throw しない）。次サイクルで状態は再評価される。
      // biome-ignore lint/suspicious/noConsole: Cloud Run Job の構造化運用ログ（Cloud Logging へ出力）。debug 用途でない。
      console.warn(JSON.stringify({ event: "tv.health_check.slack_non_2xx", status: res.status }));
    }
  } catch (err) {
    // ネットワーク例外も握りつぶす（throw すると Job が落ちる）。message に URL を載せない。
    // biome-ignore lint/suspicious/noConsole: Cloud Run Job の構造化運用ログ（Cloud Logging へ出力）。debug 用途でない。
    console.warn(
      JSON.stringify({
        event: "tv.health_check.slack_error",
        message: err instanceof Error ? err.name : "unknown",
      }),
    );
  }
}

/**
 * サマリのエッジ（downDevices / recoveredDevices）を Slack に配信し、任意で日次ハートビートを足す。
 * Webhook 未設定なら no-op（件数だけ info ログ）。フォーマッタ（純関数）は別途単体テストするため、本関数は
 * 結線のみ（ネットワークテスト対象外）。
 *
 * @param summary    チェッカの集計（エッジ配列を含む）。
 * @param now        判定基準時刻（経過分の算出に使う。entrypoint の now と揃える）。
 * @param heartbeat  日次ハートビートを送るか（env `TV_LIVENESS_HEARTBEAT` で gate、毎分は送らない）。
 * @param alertOnRecovery  復帰(🟢)通知を送るか（既定 false = 立ち下がり down のみ通知。env
 *   `TV_ALERT_ON_RECOVERY` で opt-in、F16 §9）。down→ok の状態遷移は checker が記録するため通知抑制と独立。
 */
export async function deliverTvLivenessAlerts(
  summary: TvLivenessCheckSummary,
  now: Date,
  heartbeat: boolean,
  alertOnRecovery = false,
): Promise<void> {
  const webhookUrl = getSlackWebhookUrl();
  if (webhookUrl === null) {
    // URL 未注入（CI / 未設定環境）。配信せず、配信すべきだった件数だけ可視化する（PII 非含み）。
    // biome-ignore lint/suspicious/noConsole: Cloud Run Job の構造化運用ログ（Cloud Logging へ出力）。debug 用途でない。
    console.info(
      JSON.stringify({
        event: "tv.health_check.slack_skipped",
        reason: "SLACK_WEBHOOK_URL unset",
        downDevices: summary.downDevices.length,
        recoveredDevices: summary.recoveredDevices.length,
        longSilentDevices: summary.longSilentDevices.length,
        longSilenceClearedDevices: summary.longSilenceClearedDevices.length,
        alertOnRecovery,
        heartbeat,
      }),
    );
    return;
  }

  // down エッジは常に 1 件 1 POST（🔴）。順次送る（件数は通常 0〜数件で並列化不要、Slack のレート制限にも優しい）。
  for (const device of summary.downDevices) {
    await postSlack(webhookUrl, formatTvDownMessage(device, now));
  }
  // 長時間サイレンス エッジ（⚠️）は **down(🔴) とは別シグナル**として常に 1 件 1 POST する（schedule-agnostic：
  // OFF/休日でも 24/7 ポーリング前提ゆえ 6h 無音は実障害）。dedup 列の send-once は checker 側で保証されるので
  // ここでは新規突入エッジをそのまま送るだけ（既に通知済みの継続中は summary に積まれない）。
  for (const device of summary.longSilentDevices) {
    await postSlack(webhookUrl, formatTvLongSilenceMessage(device, now));
  }
  // 復帰エッジ（🟢）は既定で送らない（F16 §9: 立ち下がり = down のみ通知する運用方針）。alert_state の
  // down→ok 遷移は checker（applyTransitions）が DB に記録するため、🟢 を送らなくても次の down エッジは
  // 正しく発火する（通知抑制と状態機械は独立）。`TV_ALERT_ON_RECOVERY=1` で復帰通知を opt-in できる。
  // 長時間サイレンスの復帰（🟢 サイレンス復帰）も同じ opt-in gate に乗せる（dedup 列のクリアは checker が
  // 記録するため、🟢 を送らなくても次の途絶で再アラートできる）。
  if (alertOnRecovery) {
    for (const device of summary.recoveredDevices) {
      await postSlack(webhookUrl, formatTvRecoveredMessage(device));
    }
    for (const device of summary.longSilenceClearedDevices) {
      await postSlack(webhookUrl, formatTvLongSilenceClearedMessage(device));
    }
  }

  // 日次ハートビート（dead-man's-switch）。env flag が立っているときだけ（毎分はスパムになるため送らない）。
  if (heartbeat) {
    await postSlack(webhookUrl, formatHeartbeatMessage(summary));
  }
}
