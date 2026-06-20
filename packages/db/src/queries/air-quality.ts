import { type InferSelectModel, and, desc, eq, gte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AirQualitySource } from "../_shared/enums.js";
import type { TenantTx } from "../client.js";
import { airQualityIndex } from "../schema/air-quality.js";

/**
 * ADR-046: 大気質(PM2.5)/UV指数 キャッシュ `air_quality_index` のクエリ層。
 *
 * 2 系統に分かれる（heat-alerts.ts / weather-warnings.ts と同じ「読みは RLS 委譲 / 書きは system context」構造）:
 *   1. **取得 Job 側の書き込み** (`upsertAirQuality`): `system_admin` コンテキストを張った接続で呼ぶ。
 *      `air_quality_index_write_system_*` policy（migration 0033）が書き込みを system に限定する。WHERE/role を
 *      手書きせず DB の RLS に委ねる（ルール2）。`(area_code, source, forecast_date)` 競合で `onConflictDoUpdate`
 *      して last-known-good を更新する（冪等な再取得）。
 *   2. **サイネージ読み取り側** (`getAirQualityByArea`): `air_quality_index_read_all` policy（USING (true)）により
 *      匿名サイネージ接続（role 未設定、school_id のみ or 無し）でも読める。大気質・UV は公開・非 PII の cross-tenant
 *      共有キャッシュなので SELECT 全開放（ADR-044 §決定 4）。手書きの `WHERE school_id=?` は無い（そもそも
 *      school_id を持たない参照テーブル）。
 *
 * 型は schema の `airQualityIndex` から派生する（ルール3、手書きドメイン型を作らない）。
 */

/** SELECT だけできれば良い接続（db / tx の両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type AirQualityRow = InferSelectModel<typeof airQualityIndex>;

/** サイネージ表示・運用で参照する大気質 / UV 行（schema 由来、全フィールド）。 */
export type AirQuality = AirQualityRow;

/**
 * 取得 Job が 1 地域・1 日ぶんを upsert する入力。
 * `source` は省略時 'env_soramame'。各フィールドは取得できない場合 null に倒す（fail-soft）。UV は本 PR では取得
 * しないため uvIndex / uvBand は通常 null。
 */
export type UpsertAirQualityInput = {
  areaCode: string;
  areaName?: string | null;
  source?: AirQualityRow["source"];
  /** 取得時刻。省略時は DB の now()（鮮度判定の基準）。 */
  fetchedAt?: Date;
  /** 対象日（JST 暦日、'YYYY-MM-DD'）。 */
  forecastDate: string;
  /** PM2.5 濃度（µg/m³ 相当の整数）。取得できない場合は null。 */
  pm25?: number | null;
  /** PM2.5 区分（取得 Job のパーサ導出）。取得できない場合は null。 */
  pm25Band?: string | null;
  /** 光化学オキシダント（任意指標）。本 PR は通常 null（follow-up）。 */
  oxidant?: number | null;
  /** UV インデックス（本 PR は通常 null・列予約）。 */
  uvIndex?: number | null;
  /** UV 区分（本 PR は通常 null）。 */
  uvBand?: string | null;
  /** 原文（そらまめくん / 気象庁の該当地域の代表値を正規化したオブジェクト）。後追い解析用に残す。 */
  raw?: unknown;
};

/**
 * 大気質 / UV を 1 行 upsert する（取得 Job 用、system context で呼ぶ）。
 *
 * `(area_code, source, forecast_date)` 競合時は数値・区分・取得時刻・原文を差し替える（UPDATE 分岐でも
 * `updatedAt` を明示更新する。ルール1: `auditColumns.updatedAt` は INSERT 既定のみで `$onUpdate`/トリガを持た
 * ないため、明示しないと作成時刻のまま残り監査不整合になる。[[updatedat-explicit-on-update]]）。
 * `createdBy` / `updatedBy` は null（システム = `system://weather-fetch`、auditColumns の「システム作成は null」規約）。
 *
 * @param tx system_admin コンテキストを張ったトランザクション。
 * @returns upsert 後の行 id。
 */
export async function upsertAirQuality(
  tx: TenantTx,
  input: UpsertAirQualityInput,
): Promise<string> {
  const source: AirQualitySource = input.source ?? "env_soramame";
  const pm25 = input.pm25 ?? null;
  const pm25Band = input.pm25Band ?? null;
  const oxidant = input.oxidant ?? null;
  const uvIndex = input.uvIndex ?? null;
  const uvBand = input.uvBand ?? null;
  const rawValue = input.raw ?? {};
  const rows = await tx
    .insert(airQualityIndex)
    .values({
      areaCode: input.areaCode,
      areaName: input.areaName ?? null,
      source,
      ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
      forecastDate: input.forecastDate,
      pm25,
      pm25Band,
      oxidant,
      uvIndex,
      uvBand,
      raw: rawValue,
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: [airQualityIndex.areaCode, airQualityIndex.source, airQualityIndex.forecastDate],
      set: {
        areaName: input.areaName ?? null,
        fetchedAt: input.fetchedAt ?? new Date(),
        pm25,
        pm25Band,
        oxidant,
        uvIndex,
        uvBand,
        raw: rawValue,
        // ルール1: 再取得時刻として updated_at を明示更新（created_at / created_by は初回値を保つ）。
        updatedAt: new Date(),
        updatedBy: null,
      },
    })
    .returning({ id: airQualityIndex.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("upsertAirQuality: INSERT ... RETURNING が行を返しませんでした");
  }
  return id;
}

/**
 * 指定地域・指定ソースの、`fromDate` 以降で最も新しい対象日の大気質 / UV 行を返す（無ければ null）。
 * サイネージ大気質ウィジェット用。サイネージ匿名コンテキスト（role 未設定）でも `air_quality_index_read_all`
 * により読める。
 *
 * `fromDate` を渡すと「今日（JST 暦日）以降」の最新 1 行に絞れる（古い日付の残骸を表示しないため）。対象日
 * 降順で 1 行を採る。
 *
 * @param db        SELECT 可能な接続 / tx（匿名サイネージは school_id のみ or 無しで可）。
 * @param areaCode  府県予報区コード（学校の prefecture から導出）。
 * @param fromDate  この日（'YYYY-MM-DD' JST）以降の対象日に絞る。
 * @param source    データソース（既定 'env_soramame'）。
 */
export async function getAirQualityByArea(
  db: Selectable,
  areaCode: string,
  fromDate: string,
  source: AirQualityRow["source"] = "env_soramame",
): Promise<AirQuality | null> {
  const rows = await db
    .select()
    .from(airQualityIndex)
    .where(
      and(
        eq(airQualityIndex.areaCode, areaCode),
        eq(airQualityIndex.source, source),
        gte(airQualityIndex.forecastDate, fromDate),
      ),
    )
    .orderBy(desc(airQualityIndex.forecastDate))
    .limit(1);
  return rows[0] ?? null;
}
