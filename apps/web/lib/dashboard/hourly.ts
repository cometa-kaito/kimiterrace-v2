import type { HourlyEventCount } from "@kimiterrace/db";

/**
 * F08 (#44): 時間帯別 (JST hour-of-day) 集計の表示用ヘルパー。**純粋関数のみ**。
 *
 * `getHourlyEventCounts` は events が存在する時だけを返す (sparse)。ダッシュボードでは 1 日 24 時間
 * 全体の傾向を見せたいので、欠けた時を 0 件で埋めて 0〜23 時の密な 24 要素に整える。Server Component
 * から切り出して単体テスト可能にする (reports の month ユーティリティと同方針)。
 */

/** 0〜23 時を必ず網羅した 24 要素 (時昇順)。欠けた時は views/taps=0 で埋める。 */
export function densifyHourly(hourly: HourlyEventCount[]): HourlyEventCount[] {
  const byHour = new Map<number, HourlyEventCount>();
  for (const h of hourly) {
    // 0-23 の範囲内のみ採用 (DB は JST hour を返すため通常この範囲だが、防御的に弾く)。
    if (Number.isInteger(h.hour) && h.hour >= 0 && h.hour <= 23) {
      byHour.set(h.hour, h);
    }
  }
  return Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, views: 0, taps: 0 });
}

/** 期間内に view/tap が 1 件でもあるか (時間帯セクションの空表示判定)。 */
export function hasHourlyData(hourly: HourlyEventCount[]): boolean {
  return hourly.some((h) => h.views + h.taps > 0);
}

/** JST の時 (0-23) を "9時" のような表示に整える。 */
export function formatHour(hour: number): string {
  return `${hour}時`;
}
