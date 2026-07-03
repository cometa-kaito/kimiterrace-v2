import { type InferSelectModel, and, asc, eq, gte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TenantTx } from "../client.js";
import { weatherForecasts } from "../schema/weather-forecasts.js";

/**
 * F14 (#128, ADR-021): 天気予報キャッシュ `weather_forecasts` のクエリ層。
 *
 * 2 系統に分かれる（feedback.ts / sensor-presence.ts と同じ「読みは RLS 委譲 / 書きは system context」構造）:
 *   1. **取得 Job 側の書き込み** (`upsertWeatherForecast`): `system_admin`（または将来の system_service）
 *      コンテキストを張った接続で呼ぶ。`weather_write_system` policy（migration 0016）が書き込みを system
 *      に限定する。WHERE/role を手書きせず DB の RLS に委ねる（ルール2）。`(area_code, source,
 *      forecast_date)` 競合で `onConflictDoUpdate` して last-known-good を更新する（冪等な再取得）。
 *   2. **サイネージ読み取り側** (`getForecastByArea` / `getCurrentForecastDay`): `weather_read_all` policy
 *      （USING (true)）により匿名サイネージ接続（role 未設定、school_id のみ or 無し）でも読める。天気は
 *      公開・非 PII の cross-tenant 共有キャッシュなので SELECT 全開放（ADR-021 §結果）。手書きの
 *      `WHERE school_id=?` は無い（そもそも school_id を持たない参照テーブル）。
 *
 * 型は schema の `weatherForecasts` から派生する（ルール3、手書きドメイン型を作らない）。
 */

/** SELECT だけできれば良い接続（db / tx の両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type WeatherForecastRow = InferSelectModel<typeof weatherForecasts>;

/** サイネージ表示・運用で参照する天気予報行（schema 由来、全フィールド）。 */
export type WeatherForecast = WeatherForecastRow;

/**
 * 取得 Job が 1 地域・1 対象日ぶんを upsert する入力。
 * `source` は省略時 'jma'。気温・降水確率・コード・テキストは取得できない日もあるため任意（null 可）。
 */
export type UpsertWeatherForecastInput = {
  areaCode: string;
  areaName?: string | null;
  source?: WeatherForecastRow["source"];
  /** JST 暦日 'YYYY-MM-DD'。一意キーの一部。 */
  forecastDate: string;
  /** 取得時刻。省略時は DB の now()（鮮度判定の基準）。 */
  fetchedAt?: Date;
  weatherCode?: string | null;
  weatherText?: string | null;
  tempMin?: number | null;
  tempMax?: number | null;
  pop?: number | null;
  /** 原文 JSON の保全（JMA bosai は非公式・無保証のため後追い解析用に残す）。 */
  raw?: unknown;
};

/**
 * 天気予報を 1 行 upsert する（取得 Job 用、system context で呼ぶ）。
 *
 * `(area_code, source, forecast_date)` 競合時は予報値・取得時刻・原文を差し替える（UPDATE 分岐でも
 * `updatedAt` を明示更新する。ルール1: `auditColumns.updatedAt` は INSERT 既定のみで `$onUpdate`/トリガを
 * 持たないため、明示しないと作成時刻のまま残り監査不整合になる。[[updatedat-explicit-on-update]]）。
 * `createdBy` / `updatedBy` は null（システム = `system://weather-fetch`、auditColumns の「システム作成は
 * null」規約）。
 *
 * ## ★ 気温は last-known-good を壊さない（`COALESCE(excluded, 既存)`, 2026-07-03 修正）
 * JMA の **17:00 発表（夕方版）は「本日」の気温を予報から落とす**（本日の最高はもう過ぎたため）。
 * 一方で本日の天気コード/テキスト/降水確率は夕方版にも残るので、パーサは本日を `days[]` に
 * `tempMin=tempMax=null` で載せ、その upsert が **朝版で入った本日の実気温を null で上書き**してサイネージが
 * 「—」表示になっていた（本バグの根治点）。気温だけは新値が null なら既存値を保持する
 * （`COALESCE(excluded.temp_x, weather_forecasts.temp_x)`）ことで、朝版の本日気温が夕方版で消えない。
 * 新しい非 null 値（正当な更新・訂正）は従来どおり上書きされる（COALESCE は excluded 非 null を優先）。
 * 対象日が過ぎれば読取（`getForecastByArea` は fromDate 以降のみ）から外れるため stale 化の懸念は無い。
 * 天気コード/テキスト/降水確率は「本日」でも常に供給されるため上書き保持は不要（気温に限定してスコープを絞る）。
 *
 * @param tx system_admin（または system_service）コンテキストを張ったトランザクション。
 * @returns upsert 後の行 id。
 */
export async function upsertWeatherForecast(
  tx: TenantTx,
  input: UpsertWeatherForecastInput,
): Promise<string> {
  const source = input.source ?? "jma";
  const rawValue = input.raw ?? {};
  const rows = await tx
    .insert(weatherForecasts)
    .values({
      areaCode: input.areaCode,
      areaName: input.areaName ?? null,
      source,
      ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
      forecastDate: input.forecastDate,
      weatherCode: input.weatherCode ?? null,
      weatherText: input.weatherText ?? null,
      tempMin: input.tempMin ?? null,
      tempMax: input.tempMax ?? null,
      pop: input.pop ?? null,
      raw: rawValue,
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: [weatherForecasts.areaCode, weatherForecasts.source, weatherForecasts.forecastDate],
      set: {
        areaName: input.areaName ?? null,
        fetchedAt: input.fetchedAt ?? new Date(),
        weatherCode: input.weatherCode ?? null,
        weatherText: input.weatherText ?? null,
        // ★ 気温は新値が null なら既存値を保持（JMA 夕方版が本日気温を落とすため。上記 doc 参照）。
        // excluded.temp_x = 今回 INSERT 値（input.tempX ?? null）、weatherForecasts.temp_x = 既存行値。
        tempMin: sql`coalesce(excluded.${sql.raw(weatherForecasts.tempMin.name)}, ${weatherForecasts.tempMin})`,
        tempMax: sql`coalesce(excluded.${sql.raw(weatherForecasts.tempMax.name)}, ${weatherForecasts.tempMax})`,
        pop: input.pop ?? null,
        raw: rawValue,
        // ルール1: 再取得時刻として updated_at を明示更新（created_at / created_by は初回値を保つ）。
        updatedAt: new Date(),
        updatedBy: null,
      },
    })
    .returning({ id: weatherForecasts.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("upsertWeatherForecast: INSERT ... RETURNING が行を返しませんでした");
  }
  return id;
}

/**
 * 指定地域の予報を、対象日 `fromDate` 以降ぶん古い順（forecast_date 昇順）に返す。
 * サイネージ匿名コンテキスト（role 未設定）でも `weather_read_all` により読める。
 *
 * @param db        SELECT 可能な接続 / tx（匿名サイネージは school_id のみ or 無しで可）。
 * @param areaCode  JMA 地域コード（学校の prefecture から導出）。
 * @param fromDate  この JST 暦日（'YYYY-MM-DD'）以降の予報のみ返す（過去日を除外）。
 * @param source    データソース（既定 'jma'）。
 */
export async function getForecastByArea(
  db: Selectable,
  areaCode: string,
  fromDate: string,
  source: WeatherForecastRow["source"] = "jma",
): Promise<WeatherForecast[]> {
  return db
    .select()
    .from(weatherForecasts)
    .where(
      and(
        eq(weatherForecasts.areaCode, areaCode),
        eq(weatherForecasts.source, source),
        gte(weatherForecasts.forecastDate, fromDate),
      ),
    )
    .orderBy(asc(weatherForecasts.forecastDate));
}

/**
 * 指定地域・指定対象日の予報を 1 行だけ返す（無ければ null）。本日の天気ウィジェット用。
 */
export async function getForecastForDay(
  db: Selectable,
  areaCode: string,
  forecastDate: string,
  source: WeatherForecastRow["source"] = "jma",
): Promise<WeatherForecast | null> {
  const rows = await db
    .select()
    .from(weatherForecasts)
    .where(
      and(
        eq(weatherForecasts.areaCode, areaCode),
        eq(weatherForecasts.source, source),
        eq(weatherForecasts.forecastDate, forecastDate),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 取得 Job が次サイクルで取りに行く地域コード集合を `schools` から導出するための重複排除ユーティリティ。
 * 実 DB 読み取り（system_admin context での `listSchools` 等）は呼び出し側で行い、本関数は **純粋な
 * dedup**（テスト容易）に徹する。同一地域の複数校を 1 回の JMA 取得に畳む（ADR-021 §決定の地域 dedup）。
 */
export function dedupeAreaCodes(areaCodes: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of areaCodes) {
    if (typeof code === "string" && code.length > 0 && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}
