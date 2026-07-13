import { type InferSelectModel, and, desc, eq, gte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { HeatAlertLevel, WbgtBand } from "../_shared/enums.js";
import type { TenantTx } from "../client.js";
import { heatAlerts } from "../schema/heat-alerts.js";

/**
 * ADR-044: 熱中症警戒アラート / WBGT キャッシュ `heat_alerts` のクエリ層。
 *
 * 2 系統に分かれる（weather-warnings.ts / weather-forecasts.ts と同じ「読みは RLS 委譲 / 書きは system
 * context」構造）:
 *   1. **取得 Job 側の書き込み** (`upsertHeatAlert`): `system_admin` コンテキストを張った接続で呼ぶ。
 *      `heat_alerts_write_system_*` policy（migration 0030）が書き込みを system に限定する。WHERE/role を
 *      手書きせず DB の RLS に委ねる（ルール2）。`(area_code, source, forecast_date)` 競合で
 *      `onConflictDoUpdate` して last-known-good を更新する（冪等な再取得）。
 *   2. **サイネージ読み取り側** (`getHeatAlertByArea`): `heat_alerts_read_all` policy（USING (true)）により
 *      匿名サイネージ接続（role 未設定、school_id のみ or 無し）でも読める。熱中症アラートは公開・非 PII の
 *      cross-tenant 共有キャッシュなので SELECT 全開放（ADR-044 §決定 4）。手書きの `WHERE school_id=?` は無い
 *      （そもそも school_id を持たない参照テーブル）。
 *
 * 型は schema の `heatAlerts` から派生する（ルール3、手書きドメイン型を作らない）。
 */

/** SELECT だけできれば良い接続（db / tx の両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type HeatAlertRow = InferSelectModel<typeof heatAlerts>;

/** サイネージ表示・運用で参照する熱中症アラート行（schema 由来、全フィールド）。 */
export type HeatAlert = HeatAlertRow;

/**
 * 取得 Job が 1 地域・1 日ぶんを upsert する入力。
 * `source` は省略時 'env_moe'。各フィールドは取得できない場合 null / 既定（none）に倒す（fail-soft）。
 */
export type UpsertHeatAlertInput = {
  areaCode: string;
  areaName?: string | null;
  source?: HeatAlertRow["source"];
  /** 取得時刻。省略時は DB の now()（鮮度判定の基準）。 */
  fetchedAt?: Date;
  /** アラートの対象日（JST 暦日、'YYYY-MM-DD'）。 */
  forecastDate: string;
  /** 熱中症アラート段階（省略時 'none'）。 */
  alertLevel?: HeatAlertLevel;
  /** その日のピーク WBGT（整数℃相当）。取得できない場合は null。 */
  wbgtMax?: number | null;
  /** ピーク WBGT の区分。取得できない場合は null。 */
  wbgtBand?: WbgtBand | null;
  /** 原文（環境省 CSV の該当地域行を正規化したオブジェクト）。後追い解析用に残す。 */
  raw?: unknown;
};

/**
 * 熱中症アラートを 1 行 upsert する（取得 Job 用、system context で呼ぶ）。
 *
 * `(area_code, source, forecast_date)` 競合時はアラート段階・WBGT・取得時刻・原文を差し替える（UPDATE 分岐
 * でも `updatedAt` を明示更新する。ルール1: `auditColumns.updatedAt` は INSERT 既定のみで `$onUpdate`/トリガを
 * 持たないため、明示しないと作成時刻のまま残り監査不整合になる。[[updatedat-explicit-on-update]]）。
 * `createdBy` / `updatedBy` は null（システム = `system://weather-fetch`、auditColumns の「システム作成は null」
 * 規約）。
 *
 * @param tx system_admin コンテキストを張ったトランザクション。
 * @returns upsert 後の行 id。
 */
export async function upsertHeatAlert(tx: TenantTx, input: UpsertHeatAlertInput): Promise<string> {
  const source = input.source ?? "env_moe";
  const alertLevel: HeatAlertLevel = input.alertLevel ?? "none";
  const wbgtMax = input.wbgtMax ?? null;
  const band = input.wbgtBand ?? null;
  const rawValue = input.raw ?? {};
  const rows = await tx
    .insert(heatAlerts)
    .values({
      areaCode: input.areaCode,
      areaName: input.areaName ?? null,
      source,
      ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
      forecastDate: input.forecastDate,
      alertLevel,
      wbgtMax,
      wbgtBand: band,
      raw: rawValue,
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: [heatAlerts.areaCode, heatAlerts.source, heatAlerts.forecastDate],
      set: {
        areaName: input.areaName ?? null,
        fetchedAt: input.fetchedAt ?? new Date(),
        // alertLevel は無条件更新のまま（夕方に severe→none へ正当に落ちる更新を許す）。
        alertLevel,
        // ★ WBGT の数値/バンドは新値が null なら既存を保持（成功した 2xx でも該当地域行なし・
        // WBGT 列が空だと parse が null に倒れ、非 COALESCE だと同日先行の記録ピーク WBGT を潰す）。
        // 保存日 forecast_date が競合キーに含まれるので保持は「同日内」に限られる（翌日は別行）。
        wbgtMax: sql`coalesce(excluded.${sql.raw(heatAlerts.wbgtMax.name)}, ${heatAlerts.wbgtMax})`,
        wbgtBand: sql`coalesce(excluded.${sql.raw(heatAlerts.wbgtBand.name)}, ${heatAlerts.wbgtBand})`,
        raw: rawValue,
        // ルール1: 再取得時刻として updated_at を明示更新（created_at / created_by は初回値を保つ）。
        updatedAt: new Date(),
        updatedBy: null,
      },
    })
    .returning({ id: heatAlerts.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("upsertHeatAlert: INSERT ... RETURNING が行を返しませんでした");
  }
  return id;
}

/**
 * 指定地域・指定ソースの、`fromDate` 以降で最も新しい対象日の熱中症アラート 1 行を返す（無ければ null）。
 * サイネージ熱中症ウィジェット用。サイネージ匿名コンテキスト（role 未設定）でも `heat_alerts_read_all` により
 * 読める。
 *
 * `fromDate` を渡すと「今日（JST 暦日）以降」の最新 1 行に絞れる（古い日付の残骸を表示しないため）。対象日
 * 降順で 1 行を採る。
 *
 * @param db        SELECT 可能な接続 / tx（匿名サイネージは school_id のみ or 無しで可）。
 * @param areaCode  府県予報区コード（学校の prefecture から導出）。
 * @param fromDate  この日（'YYYY-MM-DD' JST）以降の対象日に絞る。
 * @param source    データソース（既定 'env_moe'）。
 */
export async function getHeatAlertByArea(
  db: Selectable,
  areaCode: string,
  fromDate: string,
  source: HeatAlertRow["source"] = "env_moe",
): Promise<HeatAlert | null> {
  const rows = await db
    .select()
    .from(heatAlerts)
    .where(
      and(
        eq(heatAlerts.areaCode, areaCode),
        eq(heatAlerts.source, source),
        gte(heatAlerts.forecastDate, fromDate),
      ),
    )
    .orderBy(desc(heatAlerts.forecastDate))
    .limit(1);
  return rows[0] ?? null;
}
