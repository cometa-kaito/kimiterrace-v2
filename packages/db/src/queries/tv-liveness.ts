import type { TvSchedule } from "../schema/tv-devices.js";

/**
 * F16 (ADR-023): TV 死活ギャップチェッカの **純粋判定ロジック**。
 *
 * 既存ポーリング心拍（`tv_devices.last_seen_at`、ADR-022 の 60 秒ポーリングが更新）の鮮度だけで死活を
 * 判定する。新たな常時接続は張らない（ADR-023 採用案 A）。本ファイルは I/O を一切持たない純関数で、
 * 「いま・各 TV の last_seen_at・閾値」を入力に「down 遷移した TV / recover 遷移した TV」を出力する
 * （`apps/jobs` の死活ジョブと `packages/db` のトランザクション層が、この判定を DB 状態に反映する）。
 *
 * ## 閾値（ADR-023 / F16 §2、環境変数で調整可）
 *  - `downThresholdSec`（既定 180 = 3 分）: `now - last_seen_at` がこれを超えたら down。60 秒ポーリング ×
 *    3 回欠落に相当（瞬断・1 回欠落の誤報を抑制、F16 §2 誤報抑制）。
 *  - `offHoursThresholdSec`（既定 1800 = 30 分）: `schedule_json` の OFF 時間帯（黒画面・夜間/休日）は
 *    閾値を緩める（F16 §2）。OFF 時間帯はそもそも表示していないため、短い無応答を down と誤報しない。
 *
 * ## 遷移の定義（send-once / idempotent、F16 §2）
 *  - **down 遷移**: 「現に閾値超で無応答」かつ「まだ down 計上していない」(= `alertState==='ok'` かつ
 *    未解決ダウンタイム行が無い)。再走査で同一アウテージを二重計上しない。
 *  - **recover 遷移**: 「閾値内に戻った（鮮度 OK）」かつ「down 計上中」(= `alertState==='down'` または
 *    未解決ダウンタイム行がある)。
 *  - それ以外（ok→ok / down→down / 監視 OFF）は **no-op**。
 *
 * ## monitoring_enabled / last_seen_at NULL
 *  - `monitoringEnabled===false`（メンテ除外）の TV は down 判定しない。ただし既に down 計上中で監視を
 *    切った場合に取り残さないよう、**鮮度 OK なら recover は許す**（メンテ解除後の自然復帰を妨げない）。
 *  - `lastSeenAt===null`（一度もポーリングしていない新規登録 TV）は「まだ観測なし」として down 計上
 *    しない（設置直後の誤報を避ける。最初のポーリングが来てから死活計上を始める）。
 */

/** ダウン原因の機械推定（`tv_downtime_cause` enum と一致、ルール3 の値域単一ソースに従う）。 */
export type TvDowntimeCauseHint = "unknown" | "reboot" | "network";

/** 死活判定の入力 1 行（schema 由来のフィールド + 未解決ダウンタイム行の有無）。 */
export interface TvLivenessInput {
  /** TV の device_id（グローバル一意、ダウンタイム行の FK キー）。 */
  deviceId: string;
  /** テナント分離キー（ダウンタイム行に pin する）。 */
  schoolId: string;
  /** 最終ポーリング時刻（死活信号）。NULL = 未だ一度も観測していない。 */
  lastSeenAt: Date | null;
  /** TV からの最終起動報告（reboot 推定に使う）。NULL = 報告なし。 */
  lastBootAt: Date | null;
  /** 現在のアラート状態（重複通知抑止の状態フラグ）。 */
  alertState: "ok" | "down";
  /** 死活監視 ON/OFF（メンテ中の除外）。 */
  monitoringEnabled: boolean;
  /** サイネージ ON/OFF スケジュール（OFF 時間帯の閾値緩和に使う）。NULL = 常時 ON 扱い。 */
  schedule: TvSchedule | null;
  /**
   * この TV に未解決（recovered_at IS NULL）のダウンタイム行があるか。down/recover 遷移の冪等判定に
   * 使う（alertState だけだと、稀に alert_state と downtime 行がズレた場合に二重計上しうるため両方見る）。
   */
  hasOpenDowntime: boolean;
}

/** 判定の閾値（環境変数で調整可、F16 §6）。 */
export interface TvLivenessThresholds {
  /** 通常の down 閾値（秒）。既定 180（3 分）。 */
  downThresholdSec: number;
  /** OFF 時間帯に緩める down 閾値（秒）。既定 1800（30 分）。 */
  offHoursThresholdSec: number;
}

export const DEFAULT_TV_LIVENESS_THRESHOLDS: TvLivenessThresholds = {
  downThresholdSec: 180,
  offHoursThresholdSec: 1800,
};

/** down 遷移として記録する 1 件（チェッカがダウンタイム行を INSERT する材料）。 */
export interface TvNewlyDown {
  deviceId: string;
  schoolId: string;
  /** ダウン起点 = 最後に観測した last_seen_at。 */
  wentDownAt: Date;
}

/** recover 遷移として記録する 1 件（チェッカが未解決行を締める材料）。 */
export interface TvRecovered {
  deviceId: string;
  schoolId: string;
  /** 復帰観測時刻（チェッカ実行時刻 `now`）。 */
  recoveredAt: Date;
  /** 原因の機械推定（last_boot_at が wentDownAt 以降に進んでいれば reboot、なければ unknown）。 */
  causeHint: TvDowntimeCauseHint;
}

/** 純粋判定の出力（DB へ反映する遷移の集合）。 */
export interface TvLivenessClassification {
  newlyDown: TvNewlyDown[];
  recovered: TvRecovered[];
}

/**
 * `schedule` から、`at` 時刻（JST）がサイネージ OFF 時間帯かを判定する（純関数）。
 *
 * OFF と見なすのは: `enabled===false`（恒久 OFF）/ 当日が `weekdays` に含まれない / `onHour`〜`offHour`
 * の表示時間帯の外。時刻は JST（Asia/Tokyo, UTC+9）で評価する（学校は日本国内、ADR-021/ADR-023 と一貫）。
 * schedule が無い（NULL）TV は常時 ON 扱い（OFF でない）= 通常閾値を使う。
 */
export function isSignageOffHours(schedule: TvSchedule | null, at: Date): boolean {
  if (!schedule) return false;
  if (schedule.enabled === false) return true;

  // JST の曜日・時刻を UTC からオフセットで導出（タイムゾーンライブラリ非依存、決定論的）。
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  const jstWeekday = jst.getUTCDay(); // 0=日 .. 6=土（JST 換算後の UTC 曜日 = JST 曜日）
  const jstHour = jst.getUTCHours();

  if (schedule.weekdays !== undefined && !schedule.weekdays.includes(jstWeekday)) {
    return true; // 当日は表示曜日でない
  }

  const { onHour, offHour } = schedule;
  if (onHour === undefined || offHour === undefined) {
    return false; // 時間帯指定が無ければ（曜日条件は満たす）終日 ON 扱い
  }
  if (onHour === offHour) {
    return false; // 同値は終日 ON 扱い（縮退ケース）
  }
  if (onHour < offHour) {
    // 同日内の窓（例: 8〜18 時表示）。窓の外なら OFF。
    return jstHour < onHour || jstHour >= offHour;
  }
  // 日跨ぎの窓（例: 22〜6 時表示）。窓の外 = offHour〜onHour の昼間。
  return jstHour >= offHour && jstHour < onHour;
}

/**
 * 1 TV の鮮度が down 閾値を超えているか（純関数）。`lastSeenAt===null` は「観測なし」で down としない。
 * OFF 時間帯は緩い閾値を使う。
 */
function isStale(input: TvLivenessInput, now: Date, thresholds: TvLivenessThresholds): boolean {
  if (input.lastSeenAt === null) return false;
  const gapSec = (now.getTime() - input.lastSeenAt.getTime()) / 1000;
  const threshold = isSignageOffHours(input.schedule, now)
    ? thresholds.offHoursThresholdSec
    : thresholds.downThresholdSec;
  return gapSec > threshold;
}

/**
 * TV 群の死活を判定し、down 遷移 / recover 遷移の集合を返す（純関数・I/O なし・決定論的）。
 *
 * 「現在計上中か」は `alertState==='down' || hasOpenDowntime` の論理和で見る（多層: 状態フラグと実体行の
 * どちらかでも down を示せば down 中とみなし、ズレからの二重計上を防ぐ）。
 */
export function classifyTvLiveness(
  inputs: readonly TvLivenessInput[],
  now: Date,
  thresholds: TvLivenessThresholds = DEFAULT_TV_LIVENESS_THRESHOLDS,
): TvLivenessClassification {
  const newlyDown: TvNewlyDown[] = [];
  const recovered: TvRecovered[] = [];

  for (const input of inputs) {
    const countedDown = input.alertState === "down" || input.hasOpenDowntime;
    const stale = isStale(input, now, thresholds);

    if (stale) {
      // 監視 OFF の TV は新規 down 計上しない。既に down 計上中ならそのまま（no-op、締めない）。
      if (!input.monitoringEnabled) continue;
      if (!countedDown && input.lastSeenAt !== null) {
        newlyDown.push({
          deviceId: input.deviceId,
          schoolId: input.schoolId,
          wentDownAt: input.lastSeenAt,
        });
      }
      // countedDown かつ stale = down→down の継続 → no-op（send-once）。
      continue;
    }

    // 鮮度 OK（閾値内）。計上中なら recover として締める（監視 OFF でも自然復帰は妨げない）。
    if (countedDown) {
      const causeHint = inferCauseHint(input);
      recovered.push({
        deviceId: input.deviceId,
        schoolId: input.schoolId,
        recoveredAt: now,
        causeHint,
      });
    }
    // ok→ok = no-op。
  }

  return { newlyDown, recovered };
}

/**
 * 復帰時の原因推定（純関数）。`lastBootAt` が観測でき、かつダウン起点（last_seen_at）より後に進んで
 * いれば「ダウン中に再起動した」と推定し `reboot`。それ以外は `unknown`（電源OFF/ネット断/アプリ停止は
 * 区別不能、ADR-023 §悪い影響）。`network` は将来の通信断シグナル用に予約（現状は推定しない）。
 */
function inferCauseHint(input: TvLivenessInput): TvDowntimeCauseHint {
  if (input.lastBootAt !== null && input.lastSeenAt !== null) {
    if (input.lastBootAt.getTime() > input.lastSeenAt.getTime()) {
      return "reboot";
    }
  }
  return "unknown";
}
