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
import { heatAlertLevel, heatSource, wbgtBand } from "../_shared/enums.js";

/**
 * ADR-044: サイネージ**熱中症警戒アラート / 暑さ指数(WBGT)** の地域単位キャッシュ。
 *
 * ## 役割 — 天気（weather_forecasts / ADR-021）・気象警報（weather_warnings）と同じ閉域・公開参照キャッシュパターン
 * ADR-044（keyless 外部データの「天気 Job 相乗り」取得方式）の **3 例目**。既存の天気 Cloud Run Job
 * （`apps/jobs/src/weather/`）が **相乗り**で環境省「熱中症予防情報サイト」(https://www.wbgt.env.go.jp/) の
 * 無料・keyless な電子情報提供サービス（alert CSV）を取得し、本テーブルへ **upsert** する。**新しい
 * Cloud Run Job / Cloud Scheduler は作らない**（ADR-044 §決定: 新規固定費ゼロ）。サイネージ端末・Server
 * Component は **自社 DB から SELECT するだけ**で環境省を直叩きしない（閉域維持、[[closed-system-security]]）。
 * 同一都道府県の複数校は同一キャッシュ行を共有する。
 *
 * ## ★ なぜ school_id を持たないか（cross-tenant 参照テーブル / ADR-019 §公開参照マスタ特例）
 * 熱中症アラート・WBGT は **学校横断の公開・非 PII データ**（誰でも環境省から取得できる都道府県の暑さ指数）
 * であり、テナント分離の対象ではない。岐阜県の全校は同じ府県予報区コードの 1 行（1 日 1 行）を共有する。
 * よって本テーブルは `school_id` を持たず、RLS は tenant_isolation ではなく **「全ロール SELECT 可・書き込みは
 * system のみ」**の特例パターンを採る（weather_forecasts / weather_warnings / railway_status と同じ。ADR-044
 * §決定 4）。
 *   - SELECT 全開放（`heat_alerts_read_all`, USING (true)）: 漏れても無害な公開データ。サイネージ匿名
 *     セッション（ADR-016, role 未設定の deny-by-default 接続）が確実に読めることを保証する。
 *   - 書き込み限定（`heat_alerts_write_system_*`, system_admin のみ）: 取得 Job だけが system context で書く。
 *   RLS policy は migrations/0030_heat_alerts_rls.sql で付与する（手書き SQL 禁止のため policy は
 *   migrations 配下、テーブル DDL は drizzle-kit 生成）。
 *
 * ## ★ PII 非送信・非格納（ルール4 / ADR-044）
 * 環境省へ送るのは公開の URL（年/日付）だけ（学校・生徒・端末識別子を含めない）。本テーブルにも PII は
 * 入らない（地域コード・名称・アラート段階・WBGT 値・原文 CSV 行のみ）。**PII 列を足す変更は本特例
 * （SELECT 全開放）の前提を壊すので不可**（その場合は ADR を改める）。よって Vertex AI への送信・マスキングの
 * 対象外。
 *
 * ## 一意性 / upsert
 * `(area_code, source, forecast_date)` で一意（同一府県予報区・同一データソース・同一対象日は 1 行）。天気
 * （weather_forecasts）と同じく **日付次元を持つ**（アラートは「対象日のアラート」を日単位で持つ。環境省 CSV
 * は当日 TargetDate1 / 翌日 TargetDate2 の 2 日分を含むが、本スライスは当日（TargetDate1）を 1 行として保持する。
 * 翌日分の保持は follow-up）。再取得は competing key での UPDATE（upsert）。`fetched_at` を更新し
 * last-known-good を保つ。
 *
 * ## 派生値 alert_level / wbgt_band（ADR-044 §決定 5）
 * その地域・その日のアラート段階（none < warning(熱中症警戒) < emergency(熱中症特別警戒)）と、ピーク WBGT の
 * 区分（ほぼ安全/注意/警戒/厳重警戒/危険）を取得 Job のパーサで一元導出して持つ。盤面の存在判定・強調表示を、
 * 原文 CSV を端末側で再集計させずに済ませる（表示ロジック単純化・色非依存の段階表現、NFR05）。WBGT が取得
 * できない日は `wbgt_max` / `wbgt_band` を null に倒す（fail-soft）。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。取得 Job の書き込みは created_by/updated_by = null（システム = `system://weather-fetch`）。
 * created_by/updated_by → users(id) の FK は循環依存回避のため migrations/0030 で後付けする
 * （_shared/audit.ts と 0017（天気）/ 0029（警報）と同じパターン）。
 *
 * 関連: ADR-044（keyless 外部データの天気 Job 相乗り）, ADR-021（天気の先例）, ADR-019（RLS 二層）,
 *   ADR-016（サイネージ匿名）。weather_warnings（同 ADR の 2 例目）の双子テーブル。
 * 非スコープ（follow-up）: サイネージ盤面への熱中症アラート表示の結線（apps/web、別 PR）。翌日（TargetDate2）
 *   分の保持。
 */
export const heatAlerts = pgTable(
  "heat_alerts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // 環境省 CSV の「府県予報区等コード」（例: 岐阜県 = '210000'）。天気・警報と同じ JMA 府県予報区コード体系を
    // 再利用する共有キャッシュキー（`resolveJmaAreaCode` で学校 prefecture から導出）。
    areaCode: varchar("area_code", { length: 16 }).notNull(),
    // 地域名（表示・運用補助。環境省 CSV の府県予報区名由来）。
    areaName: varchar("area_name", { length: 120 }),
    // データソース（現状 'env_moe' のみ。環境省。JMA 由来の weather_source とは別 enum）。
    source: heatSource("source").notNull().default("env_moe"),
    // この行が環境省から取得された時刻。鮮度（staleness）判定に使う（古ければサイネージが注記表示）。
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // アラートの対象日（JST の暦日）。天気の forecast_date と同じ日次キー。
    forecastDate: date("forecast_date").notNull(),
    // 派生値: その地域・その日の熱中症アラート段階（ADR-044 §決定 5）。盤面の存在判定・強調表示に使う。
    alertLevel: heatAlertLevel("alert_level").notNull().default("none"),
    // その日のピーク暑さ指数 WBGT（整数℃相当）。取得できない場合は null（fail-soft）。
    wbgtMax: integer("wbgt_max"),
    // ピーク WBGT の区分（ほぼ安全/注意/警戒/厳重警戒/危険）。WBGT が無ければ null。
    wbgtBand: wbgtBand("wbgt_band"),
    // 原文（環境省 alert CSV の該当地域行を正規化したオブジェクト）の保全。CSV は非公式・無保証のため、
    // 後追い解析・障害調査用に原文を残す（ADR-044 §残存リスク①）。
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    // 同一府県予報区・同一ソース・同一対象日は 1 行（再取得は upsert / ON CONFLICT 競合キー）。
    uxAreaSourceDate: uniqueIndex("ux_heat_alerts_area_source_date").on(
      t.areaCode,
      t.source,
      t.forecastDate,
    ),
  }),
);
