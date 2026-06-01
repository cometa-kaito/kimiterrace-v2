import type { HourlyPresenceCount } from "@kimiterrace/db";

/**
 * F08 (#44): 効果ダッシュボードの時間帯別 **在室 (presence)** 表示用ヘルパー。**純粋関数のみ**。
 *
 * `getHourlyPresenceCounts` は presence が存在する時だけを返す (sparse)。ダッシュボードでは 1 日
 * 24 時間全体の在室傾向 (登校時/昼休み/放課後) を見せたいので、欠けた時を 0 件で埋めて 0〜23 時の
 * 密な 24 要素に整える。view/tap 用の `hourly.ts` と同方針だが、presence は別の指標 (在室 ≠ 反応)
 * かつ別の型 (`HourlyPresenceCount`) なので関数を分ける。時刻整形 (`formatHour`) は共通利用する。
 */

/** 0〜23 時を必ず網羅した 24 要素 (時昇順)。欠けた時は presence=0 で埋める。 */
export function densifyPresenceHourly(hourly: HourlyPresenceCount[]): HourlyPresenceCount[] {
  const byHour = new Map<number, HourlyPresenceCount>();
  for (const h of hourly) {
    // 0-23 の範囲内のみ採用 (DB は JST hour を返すため通常この範囲だが、防御的に弾く)。
    if (Number.isInteger(h.hour) && h.hour >= 0 && h.hour <= 23) {
      byHour.set(h.hour, h);
    }
  }
  return Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, presence: 0 });
}

/** 期間内に presence が 1 件でもあるか (在室セクションの空表示判定)。 */
export function hasPresenceData(hourly: HourlyPresenceCount[]): boolean {
  return hourly.some((h) => h.presence > 0);
}
