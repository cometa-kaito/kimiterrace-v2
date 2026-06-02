import type { HourlyPresenceCount, PresenceHeatmapCell } from "@kimiterrace/db";

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

/** 在室ヒートマップの 1 日あたりの 15 分バケット数 (24h × 4)。 */
export const HEATMAP_BUCKETS = 96;

/** 平日/休日それぞれ 96 要素 (bucket 0-95) に密化した在室ヒートマップ。 */
export type DensePresenceHeatmap = {
  /** 平日 (月〜金) の bucket 別 presence 件数 (index = bucket 0-95)。 */
  weekday: number[];
  /** 休日 (土・日) の bucket 別 presence 件数 (index = bucket 0-95)。 */
  weekend: number[];
};

/**
 * sparse な `PresenceHeatmapCell[]` (presence のある組だけ) を、平日/休日それぞれ 0-95 を必ず網羅した
 * 96 要素配列に整える。欠けたバケットは 0 で埋める。`getPresenceQuarterHourHeatmap` は presence が
 * ある (dayType, bucket) だけを返すため、ヒートマップの全セル描画には密化が要る。
 */
export function densifyPresenceHeatmap(cells: PresenceHeatmapCell[]): DensePresenceHeatmap {
  const weekday = new Array<number>(HEATMAP_BUCKETS).fill(0);
  const weekend = new Array<number>(HEATMAP_BUCKETS).fill(0);
  for (const c of cells) {
    // 0-95 の範囲のみ採用 (DB は JST バケットを返すため通常この範囲だが、防御的に弾く)。
    if (!Number.isInteger(c.bucket) || c.bucket < 0 || c.bucket >= HEATMAP_BUCKETS) {
      continue;
    }
    if (c.dayType === "weekday") {
      weekday[c.bucket] = c.presence;
    } else if (c.dayType === "weekend") {
      weekend[c.bucket] = c.presence;
    }
  }
  return { weekday, weekend };
}

/** 期間内に heatmap presence が 1 件でもあるか (ヒートマップセクションの空表示判定)。 */
export function hasPresenceHeatmapData(cells: PresenceHeatmapCell[]): boolean {
  return cells.some((c) => c.presence > 0);
}

/** 15 分バケット番号 (0-95) を JST の "HH:MM" ラベルにする。0=00:00, 95=23:45。 */
export function formatBucket(bucket: number): string {
  const hour = Math.floor(bucket / 4);
  const minute = (bucket % 4) * 15;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
