import { sql } from "drizzle-orm";
import {
  date,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { airQualitySource } from "../_shared/enums.js";

/**
 * ADR-046: サイネージ**大気質（PM2.5 / 大気汚染）+ 紫外線指数(UV)** の地域単位キャッシュ。
 *
 * ## 役割 — 天気（weather_forecasts / ADR-021）・警報（weather_warnings）・熱中症（heat_alerts / ADR-044）と同じ
 * 閉域・公開参照キャッシュパターン。ADR-044（keyless 外部データの「天気 Job 相乗り」取得方式）の **5 例目**で、
 * **最も脆いソース**（正規 JSON API が公開されていない大気質・UV）に対する適用例。既存の天気 Cloud Run Job
 * （`apps/jobs/src/weather/`）が **相乗り**で環境省「そらまめくん」(https://soramame.env.go.jp) の無料・keyless な
 * 大気汚染データ（PM2.5 等）を取得し、本テーブルへ **upsert** する。**新しい Cloud Run Job / Cloud Scheduler は
 * 作らない**（ADR-044 §決定: 新規固定費ゼロ）。サイネージ端末・Server Component は **自社 DB から SELECT する
 * だけ**で環境省を直叩きしない（閉域維持、[[closed-system-security]]）。同一地域の複数校は同一キャッシュ行を共有する。
 *
 * ## ★ なぜ最も脆いか（ADR-046 §残存リスク① / ソースの非公式・無保証）
 * 熱中症（環境省 alert CSV）・気象警報（JMA bosai JSON）は **URL/形式が確認できる**準・正規データだが、本テーブルの
 * 主ソース「そらまめくん」は **正規の公開 JSON/CSV API 契約が確認できない JS SPA**（測定局コードベースの内部 API を
 * 叩く実質スクレイプ相当）。よって取得 Job のパーサは JMA / 環境省 CSV 以上に **完全防御的**（未知・欠落・形式変化は
 * 全て null、throw しない）に作り、取得できない指標は null に倒し `raw` に原文を保全する（後追い解析・障害調査用）。
 * UV（気象庁 紫外線情報）は現状 GRIB2 バイナリ配信で keyless-JSON/CSV の府県単位取得が確立していないため、
 * **本 PR では列のみ用意し取得しない**（`uv_index` / `uv_band` は常に null・follow-up、ADR-046 §UV）。
 *
 * ## ★ なぜ school_id を持たないか（cross-tenant 参照テーブル / ADR-019 §公開参照マスタ特例）
 * 大気質・UV は **学校横断の公開・非 PII データ**（誰でも環境省・気象庁から取得できる地域の大気・紫外線情報）で
 * あり、テナント分離の対象ではない。岐阜県の全校は同じ地域コードの 1 行（1 日 1 行）を共有する。よって本テーブルは
 * `school_id` を持たず、RLS は tenant_isolation ではなく **「全ロール SELECT 可・書き込みは system のみ」**の特例
 * パターンを採る（weather_forecasts / weather_warnings / heat_alerts / railway_status と同じ。ADR-044 §決定 4）。
 *   - SELECT 全開放（`air_quality_index_read_all`, USING (true)）: 漏れても無害な公開データ。サイネージ匿名
 *     セッション（ADR-016, role 未設定の deny-by-default 接続）が確実に読めることを保証する。
 *   - 書き込み限定（`air_quality_index_write_system_*`, system_admin のみ）: 取得 Job だけが system context で書く。
 *   RLS policy は migrations/0033_air_quality_rls.sql で付与する（手書き SQL 禁止のため policy は migrations 配下、
 *   テーブル DDL は drizzle-kit 生成）。
 *
 * ## ★ PII 非送信・非格納（ルール4 / ADR-044）
 * 環境省・気象庁へ送るのは公開の URL / 測定局コード（地域）だけ（学校・生徒・端末識別子を含めない）。本テーブルにも
 * PII は入らない（地域コード・名称・大気/紫外線の数値・原文オブジェクトのみ）。**PII 列を足す変更は本特例
 * （SELECT 全開放）の前提を壊すので不可**（その場合は ADR を改める）。よって Vertex AI への送信・マスキングの対象外。
 *
 * ## 一意性 / upsert
 * `(area_code, source, forecast_date)` で一意（同一地域・同一データソース・同一対象日は 1 行）。天気・熱中症と
 * 同じく **日付次元を持つ**（その日の大気/紫外線サマリを日単位で持つ）。再取得は競合キーでの UPDATE（upsert）。
 * `fetched_at` を更新し last-known-good を保つ。`area_code` は天気・熱中症と同じ JMA 府県予報区コード体系を
 * 再利用する共有キャッシュキー（`resolveJmaAreaCode` で学校 prefecture から導出。そらまめくんの測定局コードは
 * 取得 Job 側で府県コードへ畳む）。
 *
 * ## 派生値 pm25Band / uvBand（取得 Job のパーサで一元導出）
 * 盤面の存在判定・強調表示を、原文を端末側で再集計させずに済ませる（表示ロジック単純化・色非依存の段階表現、
 * NFR05）。PM2.5 が取得できない日は `pm25` / `pm25_band` を null に倒す（fail-soft）。UV は本 PR 未取得のため常に null。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。取得 Job の書き込みは created_by/updated_by = null（システム = `system://weather-fetch`）。
 * created_by/updated_by → users(id) の FK は循環依存回避のため migrations/0033 で後付けする
 * （_shared/audit.ts と 0017（天気）/ 0029（警報）/ 0030（熱中症）と同じパターン）。
 *
 * 関連: ADR-046（大気質 / UV 取得）, ADR-044（keyless 外部データの天気 Job 相乗り = 親方式）, ADR-021（天気の先例）,
 *   ADR-019（RLS 二層）, ADR-016（サイネージ匿名）。heat_alerts（同方式の 3 例目）の姉妹テーブル。
 * 非スコープ（follow-up）: サイネージ盤面への大気質 / UV 表示の結線（apps/web、別 PR）。UV の keyless 取得経路
 *   （現状 GRIB2 のみ）。光化学オキシダント（oxidant）の取得（列は用意・取得は follow-up）。
 */
export const airQualityIndex = pgTable(
  "air_quality_index",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // 地域コード（府県予報区等コード、例: 岐阜県 = '210000'）。天気・熱中症と同じ JMA 府県予報区コード体系を
    // 再利用する共有キャッシュキー（`resolveJmaAreaCode` で学校 prefecture から導出）。そらまめくんの測定局コードは
    // 取得 Job 側で府県コードへ畳む（測定局→府県の写像は取得 Job のパーサ責務）。
    areaCode: varchar("area_code", { length: 16 }).notNull(),
    // 地域名（表示・運用補助。府県名由来。無ければ null）。
    areaName: varchar("area_name", { length: 120 }),
    // データソース（現状 'env_soramame'（大気・主目的）。'jma_uv' は列予約のみで本 PR では書き込まない）。
    source: airQualitySource("source").notNull().default("env_soramame"),
    // この行が外部から取得された時刻。鮮度（staleness）判定に使う（古ければサイネージが注記表示）。
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // 対象日（JST の暦日）。天気の forecast_date と同じ日次キー。
    forecastDate: date("forecast_date").notNull(),
    // PM2.5 濃度（µg/m³ 相当の整数。その日の代表値 = 取得時点の速報値）。取得できない場合は null（fail-soft）。
    pm25: integer("pm25"),
    // PM2.5 の区分（環境省「注意喚起のための暫定的な指針」相当の段階を取得 Job のパーサで導出。例: good/moderate/
    // unhealthy 等。値域は将来 enum 化しうるが、ソースが脆く区分体系も流動的なため当面 varchar で柔らかく持つ）。
    // PM2.5 が無ければ null。
    pm25Band: varchar("pm25_band", { length: 32 }),
    // 光化学オキシダント（Ox, ppm を 1000 倍した整数等の代表値）。任意指標。本 PR は取得せず常に null（follow-up）。
    oxidant: integer("oxidant"),
    // UV インデックス（0〜11+ の整数）。本 PR は取得経路（GRIB2 のみ）が無く常に null（列予約・follow-up）。
    uvIndex: integer("uv_index"),
    // UV インデックスの区分（low/moderate/high/very_high/extreme 相当）。本 PR は常に null（follow-up）。
    uvBand: varchar("uv_band", { length: 32 }),
    // 原文（そらまめくん / 気象庁から取得した該当地域の代表値を正規化したオブジェクト）の保全。ソースは非公式・
    // 無保証のため、後追い解析・障害調査用に原文を残す（ADR-046 §残存リスク①）。
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    // 同一地域・同一ソース・同一対象日は 1 行（再取得は upsert / ON CONFLICT 競合キー）。
    uxAreaSourceDate: uniqueIndex("ux_air_quality_index_area_source_date").on(
      t.areaCode,
      t.source,
      t.forecastDate,
    ),
  }),
);
