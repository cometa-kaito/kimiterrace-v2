import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";

/**
 * パターン2 サイネージ「鉄道」ウィジェット用、鉄道事業者の**運行情報キャッシュ**（ADR-035、2026-06-10）。
 *
 * ## 役割 — 天気（weather_forecasts / ADR-021）と同じ閉域パターン
 * backend 取得 Job（`apps/jobs/src/railway-status/`・別 PR）が名鉄公式の運行情報ページ
 * （`https://top.meitetsu.co.jp/em/`）を取得・パースして本テーブルに upsert する。サイネージ端末は
 * **本テーブルを SELECT するだけ**で名鉄サイトを直叩きしない（端末側の閉域を維持＝[[closed-system-security]]）。
 * 笠松駅（名鉄 名古屋本線・竹鼻線）が当面の対象（岐南工業の最寄）。
 *
 * ## キー — 事業者単位の「現在の運行情報」1 行
 * `operator`（例 'meitetsu'）に UNIQUE。**school_id を持たない**（運行情報は学校横断の公開情報）。
 * 予報日のような日付次元は持たず、事業者ごとに**最新の現況 1 行**を upsert（ON CONFLICT operator）する。
 *
 * ## テナント分離（ADR-019 §公開参照マスタ特例 / ルール6）
 * RLS は migrations/0025_railway_status_rls.sql で weather_forecasts（0017）と同じ二本立てにする:
 *   - `railway_status_read_all`   … FOR SELECT USING (true) = 全ロール / 匿名サイネージも読める
 *   - `railway_status_write_system`… INSERT/UPDATE/DELETE は system_admin のみ = 取得 Job だけが書く
 * SELECT 全開放は「school_id 非保持 かつ 公開・非 PII」を満たすため許される特例。**生 PII を列に入れない**
 * （運行情報の本文のみ。氏名等を入れる変更は本特例の前提を壊すので不可）。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。created_by/updated_by → users(id) の FK は循環依存回避のため migrations/0025 で
 * 後付け（weather_forecasts と同じ）。取得 Job の書き込みは null（システム）。
 */
export const railwayStatus = pgTable(
  "railway_status",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // 鉄道事業者コード（取得元単位の共有キャッシュキー。例 'meitetsu' = 名鉄）。学校横断で共有。
    operator: varchar("operator", { length: 32 }).notNull(),
    // 表示名（例「名鉄」）。
    operatorName: varchar("operator_name", { length: 64 }),
    // 運行に乱れがあるか（false = 平常）。アイコン/色分け用。主情報は statusText。
    hasDisruption: boolean("has_disruption").notNull().default(false),
    // 運行情報メッセージ本文（例「15分以上の列車の遅れはございません。」「○○線で遅延が発生しています」）。
    statusText: varchar("status_text", { length: 500 }).notNull(),
    // この行が取得された時刻。鮮度（staleness）判定に使う（古ければサイネージが注記/非表示）。
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    // 取得元 URL（運用診断用）。
    sourceUrl: text("source_url"),
    ...auditColumns,
  },
  (t) => ({
    // 事業者ごとに現況 1 行（再取得は upsert / ON CONFLICT operator）。
    uxOperator: uniqueIndex("ux_railway_status_operator").on(t.operator),
  }),
);
