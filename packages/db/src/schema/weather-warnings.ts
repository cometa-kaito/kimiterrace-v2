import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { warningLevel, weatherSource } from "../_shared/enums.js";

/**
 * ADR-044: サイネージ気象**警報・注意報**の地域単位キャッシュ。
 *
 * ## 役割 — 天気（weather_forecasts / ADR-021）と同じ閉域・公開参照キャッシュパターン
 * 既存の天気 Cloud Run Job（`apps/jobs/src/weather/`）が **相乗り**で気象庁（JMA）bosai の警報 JSON
 * （`https://www.jma.go.jp/bosai/warning/data/warning/{areaCode}.json`、areaCode = 府県予報区）を地域単位で
 * 取得し、本テーブルへ **upsert** する。**新しい Cloud Run Job / Cloud Scheduler は作らない**（ADR-044
 * §決定: 新規固定費ゼロ）。サイネージ端末・Server Component は **自社 DB から SELECT するだけ**で JMA を
 * 直叩きしない（閉域維持、[[closed-system-security]]）。同一府県の複数校は同一キャッシュ行を共有する。
 *
 * ## ★ なぜ school_id を持たないか（cross-tenant 参照テーブル / ADR-019 §公開参照マスタ特例）
 * 警報・注意報は **学校横断の公開・非 PII データ**（誰でも JMA から取得できる地域の警報）であり、テナント
 * 分離の対象ではない。岐阜県の全校は同じ岐阜県予報区コードの 1 行を共有する。よって本テーブルは
 * `school_id` を持たず、RLS は tenant_isolation ではなく **「全ロール SELECT 可・書き込みは system のみ」**の
 * 特例パターンを採る（weather_forecasts / railway_status と同じ。ADR-044 §決定 4）。
 *   - SELECT 全開放（`weather_warnings_read_all`, USING (true)）: 漏れても無害な公開データ。サイネージ匿名
 *     セッション（ADR-016, role 未設定の deny-by-default 接続）が確実に読めることを保証する。
 *   - 書き込み限定（`weather_warnings_write_system_*`, system_admin のみ）: 取得 Job だけが system context で書く。
 *   RLS policy は migrations/0029_weather_warnings_rls.sql で付与する（手書き SQL 禁止のため policy は
 *   migrations 配下、テーブル DDL は drizzle-kit 生成）。
 *
 * ## ★ PII 非送信・非格納（ルール4 / ADR-044）
 * JMA へ送るのは公開の地域コードのみ（学校・生徒・端末識別子を含めない）。本テーブルにも PII は入らない
 * （地域の警報コード・名称・ヘッドライン本文・原文 JSON のみ）。**PII 列を足す変更は本特例（SELECT 全開放）の
 * 前提を壊すので不可**（その場合は ADR を改める）。よって Vertex AI への送信・マスキングの対象外。
 *
 * ## 一意性 / upsert
 * `(area_code, source)` で一意（同一府県予報区・同一データソースは「現在の警報状況」1 行）。天気のような
 * 日付次元は持たない（警報は「いま出ているか」の現況）。再取得は competing key での UPDATE（upsert）。
 * `fetched_at` を更新し last-known-good を保つ。
 *
 * ## 派生値 max_level（ADR-044 §決定 5）
 * その地域で出ている最大の警戒段階（none < advisory(注意報) < warning(警報) < emergency(特別警報)）を
 * 取得 Job のパーサで一元導出して持つ。盤面の存在判定・強調表示を、jsonb `warnings` を端末側で再集計させずに
 * 済ませる（表示ロジック単純化・色非依存の段階表現、NFR05）。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。取得 Job の書き込みは created_by/updated_by = null（システム = `system://weather-fetch`）。
 * created_by/updated_by → users(id) の FK は循環依存回避のため migrations/0029 で後付けする
 * （_shared/audit.ts と 0017（天気）と同じパターン）。
 *
 * 関連: ADR-044（keyless 外部データの天気 Job 相乗り）, ADR-021（天気の先例）, ADR-019（RLS 二層）,
 *   ADR-016（サイネージ匿名）。
 * 非スコープ（follow-up）: サイネージ盤面への警報表示の結線（apps/web、別 PR）。
 */
export const weatherWarnings = pgTable(
  "weather_warnings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // JMA 府県予報区コード（例: 岐阜県 = '210000'）。天気と同じコード体系を再利用する共有キャッシュキー。
    areaCode: varchar("area_code", { length: 16 }).notNull(),
    // 地域名（表示・運用補助。JMA レスポンス由来）。
    areaName: varchar("area_name", { length: 120 }),
    // データソース（現状 'jma' のみ。weather_forecasts.source と同じ enum を再利用）。
    source: weatherSource("source").notNull().default("jma"),
    // この行が JMA から取得された時刻。鮮度（staleness）判定に使う（古ければサイネージが注記表示）。
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // JMA レスポンスの reportDatetime（発表時刻）。取得できない場合は null。
    reportDatetime: timestamp("report_datetime", { withTimezone: true, mode: "date" }),
    // JMA の headlineText（要約見出し本文）。長文になりうるため text。無ければ null。
    headline: text("headline"),
    // 派生値: その地域で出ている最大の警戒段階（ADR-044 §決定 5）。盤面の存在判定・強調表示に使う。
    maxLevel: warningLevel("max_level").notNull().default("none"),
    // 正規化済みの警報・注意報配列。要素は {code, name, level, status, areaName} 等（PII 非格納）。
    warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
    // 原文 JSON の保全（JMA bosai API は非公式・無保証のため、後追い解析・障害調査用に原文を残す）。
    raw: jsonb("raw").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => ({
    // 同一府県予報区・同一ソースは現況 1 行（再取得は upsert / ON CONFLICT 競合キー）。
    uxAreaSource: uniqueIndex("ux_weather_warnings_area_source").on(t.areaCode, t.source),
  }),
);
