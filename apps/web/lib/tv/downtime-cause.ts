import { isSignageOffHours } from "@kimiterrace/db";
import type { TvSchedule } from "@kimiterrace/db/schema";

/**
 * 運営整理 Phase6 (BUG-2 切り分け加速): TV ダウンタイムの **推定原因を分類する純関数**（表示/診断専用）。
 *
 * 全校横断一覧（`/ops/tv-downtime`）とデバイス単位履歴（`/ops/tv-devices/[deviceId]/history`）の両方で
 * 共通に使う。**死活判定そのもの（`@kimiterrace/db` の `tv-liveness.ts` / #851 で OFF 時間帯評価を凍結）と
 * ダウンタイム書き込み経路は一切変えない** — 既に記録された行を読み取って表示時に原因を推定するだけ。
 *
 * ## 区別できないものは断定しない（ADR-023 §悪い影響）
 * 電源OFF / ネット断 / アプリ停止は「ポーリング途絶」として観測され、サーバ側の心拍だけでは区別できない
 * （サーバ → TV の到達性検査は学校 Wi-Fi 制約で不可、ADR-022/ADR-023）。唯一 **再起動**（復帰時に
 * `last_boot_at` が進行）だけが区別でき、それは復帰時に `cause_hint='reboot'` として **行に永続化済**。
 * よって本分類器は区別可能なものだけ確定し、区別不能なケースは `indeterminate`（応答途絶・未確定）に倒す。
 *
 * ## 2 層トラスト（per-row 確定事実 > 現在の soft context）
 *  - **権威 = per-row・復帰時に凍結**: 永続化された `causeHint`・`wentDownAt`・`recoveredAt`。
 *    `causeHint` は復帰時の `last_boot_at` 突合で確定済なので過去行でも正しい。これを最優先で信頼する。
 *  - **soft context = 現在値・古い行ではズレうる**: デバイスの **現在の** `schedule`。スケジュールは滅多に
 *    変わらないが、3 ヶ月前の行を現在設定で「消灯時間帯」と判定するのは推定であって事実ではない。
 *    → 表示の根拠文（downtime-format の rationale）で「現在設定基準」と明示する。
 *  - 現在の `last_boot_at` は **渡さない**: 古い行を「昨日の再起動」で `reboot` 誤分類するため。reboot は
 *    per-row 永続化 `causeHint` からのみ取る。
 */

/**
 * 推定原因のカテゴリ（**表示・診断専用**の値域。DB の `tv_downtime_cause` enum とは別物で、
 * `TvDowntimeCauseValue` を広げない）。日本語ラベル・根拠文・候補は downtime-format.ts が一元管理する。
 */
export type DowntimeCauseCategory =
  | "reboot" // 復帰時に last_boot_at 進行を観測（per-row 確定事実）
  | "network" // 永続 cause_hint='network'（現状 inferCauseHint は出さないが将来用に防御的に分岐）
  | "scheduled_off" // 発生時刻が現在の消灯スケジュール窓内 = 正常な黒画面の可能性
  | "indeterminate" // 応答途絶: 電源OFF / ネット断 / アプリ停止 のいずれか（区別不能）
  | "ongoing_action" // 未復帰 かつ 現在 ON 時間帯 = 要対応
  | "ongoing_watch"; // 未復帰 かつ 現在 OFF 時間帯 = 様子見（消灯中）

/**
 * 分類入力 1 行。per-row 確定事実 + soft context（現在 schedule）のみ。
 * `durationSec` は `recoveredAt - wentDownAt` の冗長値でシグナルを持たないため入れない（長時間ヒューリスティック
 * は推測になるので今は足さない）。現在の `lastBootAt` も渡さない（上記 docblock の理由）。
 */
export interface DowntimeCauseInput {
  /** ダウン起点 = 最後に観測した last_seen_at。OFF 窓判定はこの「発生時刻」で行う。 */
  wentDownAt: Date;
  /** 復帰観測時刻。null = 継続中（未復帰）。 */
  recoveredAt: Date | null;
  /** 永続化された原因推定（'reboot' | 'unknown' | 'network' | null）。復帰時に凍結済で過去行でも正しい。 */
  causeHint: string | null;
  /** デバイスの現在の表示スケジュール（null = 常時 ON 扱い、isSignageOffHours と同義）。 */
  schedule: TvSchedule | null;
}

/**
 * ダウンタイム 1 行の推定原因カテゴリを返す（純関数・I/O なし・決定論的）。
 *
 * 優先順位（precedence）:
 *  1. `causeHint==='reboot'` → `reboot`（確定事実は schedule・継続中より優先。OFF 窓内の再起動も「箱が
 *     電源循環した」事実として見せる ＝ ADR-023 文脈の電源オフタイマー事故そのもの）
 *  2. `causeHint==='network'` → `network`（現状未到達だが将来 network シグナル投入時に埋もれさせない）
 *  3. 継続中（`recoveredAt===null`）→ **現在時刻** `now` で文脈評価し ongoing_action / ongoing_watch
 *  4. 復帰済 → **発生時刻** `wentDownAt` が消灯窓内なら `scheduled_off`
 *  5. それ以外（causeHint unknown/null かつ ON 窓）→ `indeterminate`
 *
 * 復帰済の OFF 判定を `wentDownAt`（発生時刻）で行う理由: アウテージは wentDownAt に始まる。`recoveredAt`
 * で判定すると「ON 中に落ちて消灯後に復帰」を誤って scheduled_off にしてしまう。継続中は「今まさに消灯中か」
 * が文脈なので `now` で評価する。
 *
 * @param input  per-row 確定事実 + 現在 schedule。
 * @param now    判定基準時刻（継続中行の文脈評価に使う。呼び出し側でリクエストごとに 1 回生成して全行で共有）。
 */
export function estimateDowntimeCause(input: DowntimeCauseInput, now: Date): DowntimeCauseCategory {
  // (1)(2) per-row 確定事実は最優先（schedule・継続中状態より強い）。
  if (input.causeHint === "reboot") return "reboot";
  if (input.causeHint === "network") return "network";

  // (3) 継続中（未復帰）は「今」の時間帯で要対応 / 様子見を出し分ける。
  if (input.recoveredAt === null) {
    return isSignageOffHours(input.schedule, now) ? "ongoing_watch" : "ongoing_action";
  }

  // (4) 復帰済: 発生時刻が消灯窓内なら正常な黒画面の可能性。
  if (isSignageOffHours(input.schedule, input.wentDownAt)) return "scheduled_off";

  // (5) 区別不能（unknown/null かつ ON 窓）= 応答途絶・未確定。
  return "indeterminate";
}
