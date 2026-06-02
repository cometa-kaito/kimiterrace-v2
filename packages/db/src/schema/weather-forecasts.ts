import { sql } from "drizzle-orm";
import {
  date,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { weatherSource } from "../_shared/enums.js";

/**
 * F14 (#128, ADR-021): サイネージ天気予報の地域単位キャッシュ。
 *
 * ## 役割
 * バックエンドの Cloud Run Job（`apps/jobs/weather-fetch`）が気象庁（JMA）無料 JSON 予報 API を
 * 地域コード単位で定期取得し、本テーブルへ **upsert** する。サイネージ端末・Server Component は
 * **自社 DB から SELECT するだけ**で外部 API を直接叩かない（閉域維持、[[closed-system-security]]）。
 * 同一地域の複数校は同一キャッシュ行を共有する（JMA 呼び出しを地域単位で dedup）。
 *
 * ## ★ なぜ school_id を持たないか（cross-tenant 参照テーブル / ADR-019 の例外）
 * 天気は **学校横断の公開・非 PII データ**（誰でも JMA から取得できる地域の予報）であり、テナント分離
 * の対象ではない。岐阜県の全校は同じ岐阜県予報区コードの 1 行を共有する。よって本テーブルは
 * `school_id` を持たず、RLS は tenant_isolation ではなく **「全ロール SELECT 可・書き込みは system
 * のみ」**の特例パターンを採る（ADR-021 §結果、F14 受け入れ条件 §1）。
 *   - SELECT 全開放（`weather_read_all`, USING (true)）: 漏れても無害な公開データ。サイネージ匿名
 *     セッション（ADR-016, role 未設定の deny-by-default 接続）が確実に読めることを保証する。
 *   - 書き込み限定（`weather_write_system`, system_admin のみ）: 取得 Job だけが system context で書く。
 *   RLS policy は migrations/0016_weather_forecasts_rls.sql で付与する（手書き SQL 禁止のため policy は
 *   migrations 配下、テーブル DDL は drizzle-kit 生成）。
 *
 * ## ★ PII 非送信・非格納（ルール4 / ADR-021 §文脈）
 * JMA へ送るのは公開の地域コードのみ（学校・生徒・端末識別子を含めない）。本テーブルにも PII は
 * 入らない（地域の気象データと原文 JSON のみ）。よって Vertex AI への送信・マスキングの対象外。
 *
 * ## 一意性 / upsert
 * `(area_code, source, forecast_date)` で一意（同一地域・同一データソース・同一対象日は 1 行）。
 * 再取得は competing key での UPDATE（upsert）。`fetched_at` を更新し last-known-good を保つ。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。取得 Job の書き込みは created_by/updated_by = null（システム = `system://
 * weather-fetch`）。created_by/updated_by → users(id) の FK は循環依存回避のため migrations/0016 で
 * 後付けする（_shared/audit.ts と 0004/0006/0014 と同じパターン）。
 *
 * 関連: ADR-021（天気データソース = JMA）, F14, ADR-019（RLS 二層）, ADR-016（サイネージ匿名）, Issue #128。
 * 非スコープ（follow-up）: Cloud Run Job の Cloud Scheduler / egress 設定（Terraform、ADR-009 未作成 #94）、
 *   サイネージ Server Component への天気ウィジェット組み込み（#48-E レイアウト方針）。
 */
export const weatherForecasts = pgTable(
  "weather_forecasts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // JMA 地域コード（府県予報区。例: 岐阜県 = '210000'）。学校横断で共有するキャッシュキー。
    areaCode: varchar("area_code", { length: 16 }).notNull(),
    // 地域名（表示・運用補助。JMA レスポンス由来）。
    areaName: varchar("area_name", { length: 120 }),
    // データソース（現状 'jma' のみ）。将来フォールバック商用 API は別値で同一 area の別行になる。
    source: weatherSource("source").notNull().default("jma"),
    // この行が JMA から取得された時刻。鮮度（staleness）判定に使う（古ければサイネージが注記表示）。
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // 予報の対象日（JST 暦日）。本日 / 翌日 / 週間先頭数日ぶんを複数行で持つ。
    forecastDate: date("forecast_date").notNull(),
    // JMA 天気コード（アイコンマッピングのキー。例: '100' = 晴れ）。
    weatherCode: varchar("weather_code", { length: 8 }),
    // 天気テキスト（例: 「晴時々曇」）。色非依存表示のため必ずテキストを併記する（NFR05）。
    weatherText: varchar("weather_text", { length: 120 }),
    // 最低 / 最高気温（℃）。取得できない日は null（JMA は週間先で気温が欠ける日がある）。
    tempMin: integer("temp_min"),
    tempMax: integer("temp_max"),
    // 降水確率（%, 0-100）。取得できない場合は null。
    pop: integer("pop"),
    // 原文 JSON の保全（JMA bosai API は非公式・無保証のため、後追い解析・障害調査用に原文を残す）。
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    // 同一地域・同一ソース・同一対象日は 1 行（再取得は upsert / ON CONFLICT 競合キー）。
    uxAreaSourceDate: uniqueIndex("ux_weather_forecasts_area_source_date").on(
      t.areaCode,
      t.source,
      t.forecastDate,
    ),
  }),
);
