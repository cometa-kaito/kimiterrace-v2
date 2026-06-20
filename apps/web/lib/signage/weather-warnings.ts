import {
  type NormalizedWarning,
  type TenantTx,
  type WarningLevel,
  type WeatherWarning,
  getWarningByArea,
  resolveJmaAreaCode,
  schools,
} from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { DEFAULT_STALENESS_THRESHOLD_MS, isForecastStale } from "./weather";

/**
 * ADR-044: サイネージ**気象警報・注意報**の **読み取り層 + 表示用変換**（天気 `weather.ts` の双子）。
 *
 * バックエンドの天気 Job が相乗りで気象庁（JMA）bosai の警報 JSON を取得し `weather_warnings` に upsert
 * 済み（公開・非 PII の cross-tenant 共有キャッシュ）。サイネージ端末・Server Component は **自社 DB から
 * SELECT するだけ**で JMA を直叩きしない（閉域維持、[[closed-system-security]]）。本層はその行を盤面表示用
 * `SignageWeatherWarning` に整える。`getSignageDisplayData`（signage-display.ts）が開く既存のテナント context
 * トランザクション内で呼ぶ想定で、`getSignageWeather` と同じく `tx` を受ける。
 *
 * ## RLS（CLAUDE.md ルール2）
 * - 学校の `prefecture` 読取: 匿名サイネージ context（school_id のみ set、role 無し）は schools の
 *   `tenant_self_read` policy（id = current_school_id）で自校 1 件だけ読める（migration 0002）。
 * - 警報 読取: `weather_warnings_read_all` policy（USING (true), migration 0029）でロール非依存に読める。
 *   警報は公開・非 PII の cross-tenant 共有キャッシュ（ADR-044 §決定 4）。
 * いずれも手書き `WHERE` でテナント境界を作らず DB の RLS に委ねる。`db` は非 BYPASSRLS（kimiterrace_app）。
 *
 * ## PII（ルール4）
 * 警報コード・名称・ヘッドライン・地域名に PII は無く、Vertex AI を呼ばないためマスキング対象外（ADR-044）。
 *
 * ## 鮮度（staleness, F14 §3 / 天気と同作法）
 * `fetched_at` が `DEFAULT_STALENESS_THRESHOLD_MS`（6h）より古ければ `isStale=true` を立て、UI が「○時時点」
 * と注記する。空表示・黙った古値表示を禁止（色非依存・テキスト併記は段階ラベルが必ず併走することで担保、NFR05）。
 */

/** 盤面に出す警報・注意報 1 件（表示専用の射影。jsonb `warnings` 要素から PII を含めず整形）。 */
export type SignageWarningItem = {
  /** JMA 警報コード（例 "03" = 大雨）。React の list key 補助。 */
  code: string | null;
  /** 警報名（例「大雨警報」）。コードから解決できない場合は null（その場合は表示しない）。 */
  name: string | null;
  /** 段階（注意報 / 警報 / 特別警報）。色非依存の段階ラベルに使う。導出不能は null。 */
  level: WarningLevel | null;
  /** JMA status（"発表"/"継続"/"解除" 等）。解除済みは UI 側で間引く。 */
  status: string | null;
};

/** サイネージ警報帯のペイロード（地域名・最大段階・個別警報 + 鮮度メタ）。 */
export type SignageWeatherWarning = {
  areaCode: string;
  areaName: string | null;
  /** その地域で出ている最大の警戒段階（none < advisory < warning < emergency）。帯の存在判定・強調に使う。 */
  maxLevel: WarningLevel;
  /** JMA headlineText（要約見出し本文）。無ければ null。 */
  headline: string | null;
  /** 個別の警報・注意報（解除済みを除いた、現に出ているもの）。 */
  warnings: SignageWarningItem[];
  /** この行が JMA から取得された時刻（鮮度判定の基準）。 */
  fetchedAt: Date | null;
  /** fetched_at がしきい値より古い（= 最新取得に失敗している可能性）。UI が注記を出す。 */
  isStale: boolean;
};

/**
 * jsonb `warnings` 配列（`NormalizedWarning[]`）から、**解除済み（status が解除/"0"）を除いた**現に出ている
 * 警報を表示用に射影する純関数。drizzle の jsonb は `unknown` 相当なので、要素を防御的に narrowing する
 * （想定外形でも盤面を壊さない・fail-soft）。
 */
export function toSignageWarningItems(raw: unknown): SignageWarningItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: SignageWarningItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const w = entry as Partial<NormalizedWarning>;
    const status = typeof w.status === "string" ? w.status : null;
    // 解除（"解除" / JMA の "0"）は現況ではないので盤面に出さない。
    if (status === "解除" || status === "0") {
      continue;
    }
    items.push({
      code: typeof w.code === "string" ? w.code : null,
      name: typeof w.name === "string" ? w.name : null,
      level: typeof w.level === "string" ? (w.level as WarningLevel) : null,
      status,
    });
  }
  return items;
}

/** DB 行 → 表示ペイロードへの純変換（鮮度・個別警報の射影）。テスト容易性のため I/O から分離。 */
export function toSignageWeatherWarning(
  row: WeatherWarning,
  now: Date,
  thresholdMs: number = DEFAULT_STALENESS_THRESHOLD_MS,
): SignageWeatherWarning {
  return {
    areaCode: row.areaCode,
    areaName: row.areaName,
    maxLevel: row.maxLevel,
    headline: row.headline,
    warnings: toSignageWarningItems(row.warnings),
    fetchedAt: row.fetchedAt,
    isStale: isForecastStale(row.fetchedAt, now, thresholdMs),
  };
}

/**
 * 自校地域の気象警報・注意報をキャッシュから読む。signage-display.ts のテナント context tx 内で呼ぶ。
 *
 * 1. 自校の `prefecture` を読む（RLS: tenant_self_read で自校のみ）。
 * 2. prefecture → JMA 府県予報区コードを導出（静的マップ）。未知の府県なら null（警報帯非表示）。
 * 3. `weather_warnings` から `(area_code, source='jma')` の現況 1 行を読む（RLS: read_all、ロール非依存）。
 * 4. 表示用に変換（個別警報の射影 + 鮮度）。
 *
 * 行が無ければ null。`maxLevel='none'`（現に警報なし）でも行は返す＝**帯を出すか否かは UI 側判断**
 * （アクティブ＝maxLevel≠'none' の時だけ目立たせる）。null と none を区別できるようにし、UI に判断を委ねる。
 *
 * @param tx       テナント context（school_id set 済）のトランザクション。
 * @param schoolId 自校 id（prefecture 取得の対象特定に使う）。
 * @param now      鮮度判定の基準時刻（既定 new Date()。テストで固定可）。
 * @returns        警報ペイロード。地域未解決・キャッシュ無しなら null（UI は警報帯を出さない）。
 */
export async function getSignageWeatherWarnings(
  tx: TenantTx,
  schoolId: string,
  now: Date = new Date(),
): Promise<SignageWeatherWarning | null> {
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
  const row = await getWarningByArea(tx, areaCode);
  if (!row) {
    return null;
  }
  return toSignageWeatherWarning(row, now);
}
