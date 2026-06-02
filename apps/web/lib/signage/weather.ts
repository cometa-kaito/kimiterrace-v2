import {
  type TenantTx,
  type WeatherForecast,
  getForecastByArea,
  resolveJmaAreaCode,
  schools,
} from "@kimiterrace/db";
import { eq } from "drizzle-orm";

/**
 * F14 (#128, ADR-021): サイネージ天気予報の **読み取り層 + 表示用変換**。
 *
 * サイネージ端末は外部 API を直接叩かず、バックエンド Job が `weather_forecasts` にキャッシュした行を
 * **自社 DB から SELECT するだけ**で表示する（閉域維持、[[closed-system-security]]）。本関数は
 * `getSignageDisplayData`（signage-display.ts）が開く既存のテナント context トランザクション内で呼ぶ
 * 想定で、`effective-daily-data.ts` と同じく `tx` を受ける。
 *
 * ## RLS（CLAUDE.md ルール2）
 * - 学校の `prefecture` 読取: 匿名サイネージ context（school_id のみ set、role 無し）は schools の
 *   `tenant_self_read` policy（id = current_school_id）で自校 1 件だけ読める（migration 0002）。
 * - 天気 読取: `weather_forecasts` の `weather_read_all` policy（USING (true), migration 0016）で
 *   ロール非依存に読める。天気は公開・非 PII の cross-tenant 共有キャッシュ（ADR-021 §結果）。
 * いずれも手書き `WHERE` でテナント境界を作らず DB の RLS に委ねる。`db` は非 BYPASSRLS（kimiterrace_app）。
 *
 * ## PII（ルール4）
 * 天気・地域コードに PII は無く、Vertex AI を呼ばないためマスキング対象外（ADR-021 §文脈）。
 *
 * ## 鮮度（staleness, F14 §3）
 * `fetched_at` が `stalenessThresholdMs`（既定 6h）より古ければ `isStale=true` を立て、UI は
 * 「○時時点（最新取得に失敗）」と明示する。空表示・黙った古値表示を禁止（色非依存・テキスト併記は
 * `weatherIconFor` が name/label を必ず返すことで担保、NFR05）。
 */

/** 鮮度判定の既定しきい値（6 時間）。これより古い取得は stale 注記対象（F14 §3）。 */
export const DEFAULT_STALENESS_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** サイネージ 1 日分の天気表示要素（schema 由来の値 + 表示用アイコン/ラベル）。 */
export type WeatherDay = {
  forecastDate: string;
  weatherCode: string | null;
  /** 天気テキスト（例「晴時々曇」）。色非依存のため必ず併記する（NFR05）。 */
  weatherText: string | null;
  /** アイコンの種別キー（CSS/画像のクラス名等に使う安定キー）。 */
  icon: WeatherIcon;
  /** アイコンの代替テキスト（aria-label / 凡例。色だけに依存しない補助、NFR05）。 */
  iconLabel: string;
  tempMin: number | null;
  tempMax: number | null;
  pop: number | null;
};

/** サイネージ天気ウィジェットのペイロード（複数日 + 鮮度メタ）。 */
export type SignageWeather = {
  areaCode: string;
  areaName: string | null;
  /** この行群が JMA から取得された最新時刻（複数日のうち最も新しい fetched_at）。 */
  fetchedAt: Date | null;
  /** fetched_at がしきい値より古い（= 最新取得に失敗している可能性）。UI が注記を出す（F14 §3）。 */
  isStale: boolean;
  days: WeatherDay[];
};

/** 表示アイコンの安定キー（色だけに依存しないため必ずラベルと対で使う、NFR05）。 */
export type WeatherIcon = "sunny" | "cloudy" | "rainy" | "snowy" | "thunder" | "unknown";

/** アイコンキー → 日本語ラベル（aria-label / 凡例。色非依存の補助テキスト）。 */
const WEATHER_ICON_LABEL: Readonly<Record<WeatherIcon, string>> = {
  sunny: "晴れ",
  cloudy: "くもり",
  rainy: "雨",
  snowy: "雪",
  thunder: "雷",
  unknown: "天気不明",
};

/**
 * JMA 天気コード（"100"〜"450" 帯）→ 表示アイコン種別へマッピングする純関数。
 *
 * JMA の天気コードは百の位で大別される（公式 telops 定義に準拠した粗い分類）:
 *   - 1xx: 晴れ系 / 2xx: くもり系 / 3xx: 雨系 / 4xx: 雪系。
 *   - 雷を含むコード（例 302/308 等の一部、450 雷）は thunder を優先。
 * 細かな「晴時々雨」等の混合は代表アイコンに丸める（テキスト weatherText で補う、NFR05）。
 * 未知・null は "unknown"（空表示にせずラベルで明示）。
 */
export function weatherIconFor(weatherCode: string | null | undefined): WeatherIcon {
  if (typeof weatherCode !== "string" || weatherCode.length === 0) return "unknown";
  const n = Number.parseInt(weatherCode, 10);
  if (!Number.isFinite(n)) return "unknown";
  // 雷（450 = 雷）を最優先で拾う。
  if (n === 450) return "thunder";
  const hundreds = Math.floor(n / 100);
  switch (hundreds) {
    case 1:
      return "sunny";
    case 2:
      return "cloudy";
    case 3:
      return "rainy";
    case 4:
      return "snowy";
    default:
      return "unknown";
  }
}

/** アイコンキーのラベルを引く（色非依存の代替テキスト、NFR05）。 */
export function weatherIconLabel(icon: WeatherIcon): string {
  return WEATHER_ICON_LABEL[icon];
}

/** 取得済み行が stale（しきい値より古い）か判定する純関数。fetchedAt が null なら stale 扱い。 */
export function isForecastStale(
  fetchedAt: Date | null,
  now: Date,
  thresholdMs: number = DEFAULT_STALENESS_THRESHOLD_MS,
): boolean {
  if (fetchedAt == null) return true;
  return now.getTime() - fetchedAt.getTime() > thresholdMs;
}

/** DB 行群 → 表示ペイロードへの純変換（鮮度・アイコンを付与）。テスト容易性のため I/O から分離。 */
export function toSignageWeather(
  areaCode: string,
  rows: readonly WeatherForecast[],
  now: Date,
  thresholdMs: number = DEFAULT_STALENESS_THRESHOLD_MS,
): SignageWeather {
  const days: WeatherDay[] = rows.map((r) => {
    const icon = weatherIconFor(r.weatherCode);
    return {
      forecastDate: r.forecastDate,
      weatherCode: r.weatherCode,
      weatherText: r.weatherText,
      icon,
      iconLabel: weatherIconLabel(icon),
      tempMin: r.tempMin,
      tempMax: r.tempMax,
      pop: r.pop,
    };
  });
  // 最新の取得時刻（鮮度の代表値）。複数日のうち最大の fetched_at を採る。
  let fetchedAt: Date | null = null;
  for (const r of rows) {
    if (r.fetchedAt != null && (fetchedAt == null || r.fetchedAt.getTime() > fetchedAt.getTime())) {
      fetchedAt = r.fetchedAt;
    }
  }
  const areaName = rows.find((r) => r.areaName != null)?.areaName ?? null;
  return {
    areaCode,
    areaName,
    fetchedAt,
    isStale: isForecastStale(fetchedAt, now, thresholdMs),
    days,
  };
}

/**
 * 自校の天気予報（本日以降）をキャッシュから読む。signage-display.ts のテナント context tx 内で呼ぶ。
 *
 * 1. 自校の `prefecture` を読む（RLS: tenant_self_read で自校のみ）。
 * 2. prefecture → JMA 地域コードを導出（静的マップ）。未知の府県なら null（天気ウィジェット非表示）。
 * 3. `weather_forecasts` から本日（fromDate）以降の予報を読む（RLS: weather_read_all、ロール非依存）。
 * 4. 表示用に変換（アイコン + 鮮度）。
 *
 * @param tx       テナント context（school_id set 済）のトランザクション。
 * @param schoolId 自校 id（context と一致。prefecture 取得の対象特定に使う）。
 * @param fromDate 本日（JST 'YYYY-MM-DD'）。これ以降の予報のみ返す。
 * @param now      鮮度判定の基準時刻（既定 new Date()。テストで固定可）。
 * @returns        天気ペイロード。地域未解決・キャッシュ無しなら null（UI は天気枠を出さない）。
 */
export async function getSignageWeather(
  tx: TenantTx,
  schoolId: string,
  fromDate: string,
  now: Date = new Date(),
): Promise<SignageWeather | null> {
  const schoolRows = await tx
    .select({ prefecture: schools.prefecture })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);
  const prefecture = schoolRows[0]?.prefecture ?? null;
  const areaCode = resolveJmaAreaCode(prefecture);
  if (!areaCode) {
    return null;
  }
  const rows = await getForecastByArea(tx, areaCode, fromDate);
  if (rows.length === 0) {
    return null;
  }
  return toSignageWeather(areaCode, rows, now);
}
