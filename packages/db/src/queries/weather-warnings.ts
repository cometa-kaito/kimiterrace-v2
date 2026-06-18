import { type InferSelectModel, and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TenantTx } from "../client.js";
import type { WarningLevel } from "../_shared/enums.js";
import { weatherWarnings } from "../schema/weather-warnings.js";

/**
 * ADR-044: 気象警報・注意報キャッシュ `weather_warnings` のクエリ層。
 *
 * 2 系統に分かれる（weather-forecasts.ts と同じ「読みは RLS 委譲 / 書きは system context」構造）:
 *   1. **取得 Job 側の書き込み** (`upsertWeatherWarning`): `system_admin` コンテキストを張った接続で呼ぶ。
 *      `weather_warnings_write_system_*` policy（migration 0029）が書き込みを system に限定する。WHERE/role を
 *      手書きせず DB の RLS に委ねる（ルール2）。`(area_code, source)` 競合で `onConflictDoUpdate` して
 *      last-known-good を更新する（冪等な再取得）。
 *   2. **サイネージ読み取り側** (`getWarningByArea`): `weather_warnings_read_all` policy（USING (true)）により
 *      匿名サイネージ接続（role 未設定、school_id のみ or 無し）でも読める。警報は公開・非 PII の
 *      cross-tenant 共有キャッシュなので SELECT 全開放（ADR-044 §決定 4）。手書きの `WHERE school_id=?` は無い
 *      （そもそも school_id を持たない参照テーブル）。
 *
 * 型は schema の `weatherWarnings` から派生する（ルール3、手書きドメイン型を作らない）。
 */

/** SELECT だけできれば良い接続（db / tx の両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type WeatherWarningRow = InferSelectModel<typeof weatherWarnings>;

/** サイネージ表示・運用で参照する警報行（schema 由来、全フィールド）。 */
export type WeatherWarning = WeatherWarningRow;

/**
 * 正規化済みの警報・注意報 1 件（jsonb `warnings` 配列の要素）。PII は含めない。
 * 取得 Job のパーサ（`apps/jobs/src/weather/jma-warning.ts`）がこの形に整える。
 */
export interface NormalizedWarning {
  /** JMA 警報コード（例 "03" = 大雨）。 */
  code: string | null;
  /** 警報名（例「大雨警報」）。コードからの解決ができない場合は null。 */
  name: string | null;
  /** 段階（注意報 / 警報 / 特別警報）。導出できない場合は null。 */
  level: WarningLevel | null;
  /** JMA status（"発表"/"継続"/"解除" 等。"0" は解除を表すことがある）。 */
  status: string | null;
  /** 細分区域名（JMA areas[].name）。 */
  areaName: string | null;
}

/**
 * 取得 Job が 1 地域ぶんを upsert する入力。
 * `source` は省略時 'jma'。各フィールドは取得できない場合 null / 既定（空配列・none）に倒す（fail-soft）。
 */
export type UpsertWeatherWarningInput = {
  areaCode: string;
  areaName?: string | null;
  source?: WeatherWarningRow["source"];
  /** 取得時刻。省略時は DB の now()（鮮度判定の基準）。 */
  fetchedAt?: Date;
  /** JMA reportDatetime（発表時刻）。取得できない場合は null。 */
  reportDatetime?: Date | null;
  /** JMA headlineText（要約見出し）。 */
  headline?: string | null;
  /** 派生の最大警戒段階（省略時 'none'）。 */
  maxLevel?: WarningLevel;
  /** 正規化済みの警報・注意報配列（省略時は空配列）。 */
  warnings?: NormalizedWarning[];
  /** 原文 JSON の保全（JMA bosai は非公式・無保証のため後追い解析用に残す）。 */
  raw?: unknown;
};

/**
 * 気象警報・注意報を 1 行 upsert する（取得 Job 用、system context で呼ぶ）。
 *
 * `(area_code, source)` 競合時は警報内容・取得時刻・原文を差し替える（UPDATE 分岐でも `updatedAt` を明示
 * 更新する。ルール1: `auditColumns.updatedAt` は INSERT 既定のみで `$onUpdate`/トリガを持たないため、明示
 * しないと作成時刻のまま残り監査不整合になる。[[updatedat-explicit-on-update]]）。`createdBy` / `updatedBy`
 * は null（システム = `system://weather-fetch`、auditColumns の「システム作成は null」規約）。
 *
 * @param tx system_admin コンテキストを張ったトランザクション。
 * @returns upsert 後の行 id。
 */
export async function upsertWeatherWarning(
  tx: TenantTx,
  input: UpsertWeatherWarningInput,
): Promise<string> {
  const source = input.source ?? "jma";
  const maxLevel: WarningLevel = input.maxLevel ?? "none";
  const warnings = input.warnings ?? [];
  const rawValue = input.raw ?? {};
  const rows = await tx
    .insert(weatherWarnings)
    .values({
      areaCode: input.areaCode,
      areaName: input.areaName ?? null,
      source,
      ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
      reportDatetime: input.reportDatetime ?? null,
      headline: input.headline ?? null,
      maxLevel,
      warnings,
      raw: rawValue,
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: [weatherWarnings.areaCode, weatherWarnings.source],
      set: {
        areaName: input.areaName ?? null,
        fetchedAt: input.fetchedAt ?? new Date(),
        reportDatetime: input.reportDatetime ?? null,
        headline: input.headline ?? null,
        maxLevel,
        warnings,
        raw: rawValue,
        // ルール1: 再取得時刻として updated_at を明示更新（created_at / created_by は初回値を保つ）。
        updatedAt: new Date(),
        updatedBy: null,
      },
    })
    .returning({ id: weatherWarnings.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("upsertWeatherWarning: INSERT ... RETURNING が行を返しませんでした");
  }
  return id;
}

/**
 * 指定地域・指定ソースの「現在の警報状況」1 行を返す（無ければ null）。サイネージ警報ウィジェット用。
 * サイネージ匿名コンテキスト（role 未設定）でも `weather_warnings_read_all` により読める。
 *
 * @param db        SELECT 可能な接続 / tx（匿名サイネージは school_id のみ or 無しで可）。
 * @param areaCode  JMA 府県予報区コード（学校の prefecture から導出）。
 * @param source    データソース（既定 'jma'）。
 */
export async function getWarningByArea(
  db: Selectable,
  areaCode: string,
  source: WeatherWarningRow["source"] = "jma",
): Promise<WeatherWarning | null> {
  const rows = await db
    .select()
    .from(weatherWarnings)
    .where(and(eq(weatherWarnings.areaCode, areaCode), eq(weatherWarnings.source, source)))
    .limit(1);
  return rows[0] ?? null;
}
