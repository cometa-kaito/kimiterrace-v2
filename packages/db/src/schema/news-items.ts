import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { newsSource } from "../_shared/enums.js";

/**
 * pattern2/3 サイネージ「工学ニュース」ブロック用、外部 RSS の**ニュース見出しキャッシュ**（ADR-043、2026-06-18）。
 *
 * ## 役割 — 天気（weather_forecasts / ADR-021）・鉄道（railway_status / ADR-035）と同じ閉域パターン
 * backend 取得 Job（`apps/jobs/src/news/`・別 PR）が政府系 / JST の公開 RSS
 * （JST サイエンスポータル等）を取得・パースして本テーブルに upsert する。サイネージ端末は
 * **本テーブルを SELECT するだけ**で外部 RSS を直叩きしない（端末側の閉域を維持＝[[closed-system-security]]）。
 *
 * ## 著作権（ADR-043 の物理的担保・2026-06-20 改訂）
 * 原則は「見出し（title）+ 発表元（source/source_label）+ 公開日（published_at）+ 出典 URL（url）」のみで、
 * 著作権は事実を保護しないため、見出し + 出典 + リンクの紹介に留めれば全ソースを許諾なし・合法に表示できる。
 * **加えて、CC BY（PDL1.0 / 政府標準利用規約）ソースに限り、公式が配信する要約（summary）を出典明記で保持・
 * 表示してよい**（経産省 METI = PDL1.0 で複製・公衆送信可・出典明記必須）。**要許諾ソース（JST 等）は summary を
 * 保存しない（null）＝見出しのみ**（独自 All Rights Reserved・要約は要許諾）。文科省（mext）は CC BY だが
 * フィードに説明文が無く自然に null。**生 PII を含む本文をそのまま保存する変更は依然不可**（要約は公式配信の
 * 短い説明文に限る）。詳細は ADR-043 §2026-06-20 改訂。
 *
 * ## キー — (source, url) で重複排除
 * 同一フィードの同一記事は `(source, url)` に UNIQUE。**school_id を持たない**（ニュースは学校横断の公開情報）。
 * 再取得は upsert（ON CONFLICT (source, url)）で title / published_at / fetched_at を差し替える。
 *
 * ## テナント分離（ADR-019 §公開参照マスタ特例 / ルール2）
 * RLS は migrations/0028_news_items_rls.sql で weather_forecasts（0017）/ railway_status（0025）と同じ
 * 二本立てにする:
 *   - `news_items_read_all`   … FOR SELECT USING (true) = 全ロール / 匿名サイネージも読める
 *   - `news_items_write_system`… INSERT/UPDATE/DELETE は system_admin のみ = 取得 Job だけが書く
 * SELECT 全開放は「school_id 非保持 かつ 公開・非 PII」を満たすため許される特例。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。created_by/updated_by → users(id) の FK は循環依存回避のため migrations/0028 で
 * 後付け（weather_forecasts / railway_status と同じ）。取得 Job の書き込みは null（システム）。
 */
export const newsItems = pgTable(
  "news_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // ニュースソース（取得元単位の値域固定。jst / mext / meti）。学校横断で共有。
    source: newsSource("source").notNull(),
    // 発表元の表示名（出典明記用。例「JST サイエンスポータル」「経済産業省」）。
    sourceLabel: varchar("source_label", { length: 120 }).notNull(),
    // 見出し（RSS の <title>）。**本文は保持しない**（ADR-043 著作権方針）。
    title: varchar("title", { length: 300 }).notNull(),
    // 公式が配信する要約（2〜3 文の説明文）。**CC BY ソース（経産省 METI = PDL1.0）のみ非 null**で保持・表示し、
    // **要許諾ソース（JST 等）は null**（取得 Job 側で source ごとに gate する。ADR-043 §2026-06-20 改訂）。
    summary: text("summary"),
    // 出典 URL（記事原文へのリンク / QR 生成元）。重複排除キーの一部。
    url: text("url").notNull(),
    // 任意カテゴリ（将来のフィルタ用。当面 null 可）。
    category: varchar("category", { length: 32 }),
    // 記事の公開日時（RSS の pubDate / dc:date）。フィードに無ければ null。表示は降順。
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    // この行が取得された時刻。鮮度（staleness）判定・公開日欠落時の整列に使う。
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    ...auditColumns,
  },
  (t) => ({
    // フィード × 記事 URL で 1 行（再取得は upsert / ON CONFLICT (source, url)）。
    uxSourceUrl: uniqueIndex("ux_news_items_source_url").on(t.source, t.url),
  }),
);
