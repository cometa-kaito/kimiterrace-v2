import {
  type HeatAlert,
  type HeatAlertLevel,
  type TenantTx,
  type WbgtBand,
  getHeatAlertByArea,
  resolveJmaAreaCode,
  schools,
} from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { DEFAULT_STALENESS_THRESHOLD_MS, isForecastStale } from "./weather";

/**
 * ADR-044: サイネージ**熱中症警戒アラート / 暑さ指数(WBGT)** の **読み取り層 + 表示用変換**
 * （天気 `weather.ts` / 警報 `weather-warnings.ts` の双子）。
 *
 * バックエンドの天気 Job が相乗りで環境省「熱中症予防情報サイト」の alert CSV を取得し `heat_alerts` に
 * upsert 済み（公開・非 PII の cross-tenant 共有キャッシュ）。サイネージ端末・Server Component は **自社 DB
 * から SELECT するだけ**で環境省を直叩きしない（閉域維持、[[closed-system-security]]）。本層はその行を盤面
 * 表示用 `SignageHeatAlert` に整える。`getSignageDisplayData`（signage-display.ts）が開く既存のテナント context
 * トランザクション内で呼ぶ想定で、`getSignageWeather` と同じく `tx` を受ける。
 *
 * ## RLS（CLAUDE.md ルール2）
 * - 学校の `prefecture` 読取: 匿名サイネージ context（school_id のみ set、role 無し）は schools の
 *   `tenant_self_read` policy（id = current_school_id）で自校 1 件だけ読める（migration 0002）。
 * - 熱中症 読取: `heat_alerts_read_all` policy（USING (true), migration 0030）でロール非依存に読める。
 *   熱中症アラートは公開・非 PII の cross-tenant 共有キャッシュ（ADR-044 §決定 4）。
 * いずれも手書き `WHERE` でテナント境界を作らず DB の RLS に委ねる。`db` は非 BYPASSRLS（kimiterrace_app）。
 *
 * ## PII（ルール4）
 * 地域コード・名称・アラート段階・WBGT 値に PII は無く、Vertex AI を呼ばないためマスキング対象外（ADR-044）。
 *
 * ## 鮮度（staleness, F14 §3 / 天気と同作法）
 * `fetched_at` が `DEFAULT_STALENESS_THRESHOLD_MS`（6h）より古ければ `isStale=true` を立て、UI が「○時時点」
 * と注記する。空表示・黙った古値表示を禁止（色非依存・テキスト併記は段階ラベルが必ず併走することで担保、NFR05）。
 */

/** サイネージ熱中症帯のペイロード（段階・WBGT・対象日 + 鮮度メタ）。 */
export type SignageHeatAlert = {
  areaCode: string;
  areaName: string | null;
  /** 熱中症アラート段階（none < warning(警戒) < emergency(特別警戒)）。帯の存在判定・強調に使う。 */
  alertLevel: HeatAlertLevel;
  /** その日のピーク暑さ指数 WBGT（整数℃相当）。取得できない日は null（fail-soft）。 */
  wbgtMax: number | null;
  /** ピーク WBGT の区分（ほぼ安全/注意/警戒/厳重警戒/危険）。WBGT が無ければ null。 */
  wbgtBand: WbgtBand | null;
  /** アラートの対象日（JST 暦日 'YYYY-MM-DD'）。 */
  forecastDate: string;
  /** この行が環境省から取得された時刻（鮮度判定の基準）。 */
  fetchedAt: Date | null;
  /** fetched_at がしきい値より古い（= 最新取得に失敗している可能性）。UI が注記を出す。 */
  isStale: boolean;
};

/** DB 行 → 表示ペイロードへの純変換（鮮度の付与）。テスト容易性のため I/O から分離。 */
export function toSignageHeatAlert(
  row: HeatAlert,
  now: Date,
  thresholdMs: number = DEFAULT_STALENESS_THRESHOLD_MS,
): SignageHeatAlert {
  return {
    areaCode: row.areaCode,
    areaName: row.areaName,
    alertLevel: row.alertLevel,
    wbgtMax: row.wbgtMax,
    wbgtBand: row.wbgtBand,
    forecastDate: row.forecastDate,
    fetchedAt: row.fetchedAt,
    isStale: isForecastStale(row.fetchedAt, now, thresholdMs),
  };
}

/**
 * 自校地域の熱中症警戒アラートをキャッシュから読む。signage-display.ts のテナント context tx 内で呼ぶ。
 *
 * 1. 自校の `prefecture` を読む（RLS: tenant_self_read で自校のみ）。
 * 2. prefecture → JMA 府県予報区コードを導出（静的マップ）。未知の府県なら null（熱中症帯非表示）。
 * 3. `heat_alerts` から `(area_code, source='env_moe')` で `date` 以降の最新対象日 1 行を読む
 *    （RLS: read_all、ロール非依存。古い日付の残骸は出さない）。
 * 4. 表示用に変換（段階・WBGT + 鮮度）。
 *
 * 行が無ければ null。`alertLevel='none'`（現にアラートなし）でも行は返す＝**帯を出すか否かは UI 側判断**
 * （アクティブ＝alertLevel≠'none' の時だけ目立たせる）。null と none を区別できるようにし、UI に判断を委ねる。
 *
 * @param tx       テナント context（school_id set 済）のトランザクション。
 * @param schoolId 自校 id（prefecture 取得の対象特定に使う）。
 * @param date     本日（JST 'YYYY-MM-DD'）。この日以降の対象日に絞る。
 * @param now      鮮度判定の基準時刻（既定 new Date()。テストで固定可）。
 * @returns        熱中症ペイロード。地域未解決・キャッシュ無しなら null（UI は熱中症帯を出さない）。
 */
export async function getSignageHeatAlerts(
  tx: TenantTx,
  schoolId: string,
  date: string,
  now: Date = new Date(),
): Promise<SignageHeatAlert | null> {
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
  const row = await getHeatAlertByArea(tx, areaCode, date);
  if (!row) {
    return null;
  }
  return toSignageHeatAlert(row, now);
}
