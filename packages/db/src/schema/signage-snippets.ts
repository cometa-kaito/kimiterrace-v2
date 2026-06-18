import { boolean, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { auditColumns } from "../_shared/audit.js";
import { snippetCategory } from "../_shared/enums.js";

/**
 * サイネージ静的コンテンツ（名言 / 四字熟語 / 英単語 / 今日は何の日）の共有マスタ。
 *
 * ## 役割 — 完全ゼロコスト枠（外部 API も Cloud Run Job も使わない）
 * weather_forecasts / weather_warnings / heat_alerts / news_items（ADR-021/043/044）は外部 API を取得 Job で
 * 定期取得してキャッシュするが、**本テーブルは外部取得が一切無い**。seed 済みの静的な一般教養データ
 * （誰でも知る名言・四字熟語・英単語・記念日）を、サイネージ側が **日付決定論ローテ**（`day-of-year %
 * 件数`）で 1 件選んで表示するだけ。新しい Cloud Run Job / Cloud Scheduler / 外部 HTTP 依存・固定費は
 * 一切増えない。よって取得 Job（apps/jobs）も `run.ts` も触らない。表示の結線（apps/web の盤面）は別 PR。
 *
 * ## ★ なぜ school_id を持たないか（cross-tenant 参照テーブル / ADR-019 §公開参照マスタ特例）
 * 名言・四字熟語・英単語・記念日は **学校横断の公開・非 PII な一般教養データ**であり、テナント分離の対象では
 * ない。全校が同じ静的コンテンツ集合を共有する（weather_warnings / news_items と同じ）。よって本テーブルは
 * `school_id` を持たず、RLS は tenant_isolation ではなく **「全ロール SELECT 可・書き込みは system のみ」**の
 * 特例パターンを採る（ADR-019 適用ルール6 = school_id 非保持 かつ 公開・非 PII の両方を満たすテーブル）。
 *   - SELECT 全開放（`signage_snippets_read_all`, USING (true)）: 漏れても無害な公開教養データ。サイネージ
 *     匿名セッション（ADR-016, role 未設定の deny-by-default 接続）が確実に読めることを保証する。
 *   - 書き込み限定（`signage_snippets_write_system_*`, system_admin のみ）: seed / コンテンツ投入だけが
 *     system context で書く。一般ユーザー・匿名は書けない。
 *   RLS policy は migrations/00NN_signage_snippets_rls.sql で付与する（手書き SQL 禁止のため policy は
 *   migrations 配下、テーブル DDL は drizzle-kit 生成）。
 *
 * ## ★ PII 非格納（ルール4）— 本特例（SELECT 全開放）の前提
 * 本テーブルには **生徒・保護者・教職員の PII を一切入れない**（一般教養テキストのみ）。`attribution`（名言の
 * 著者）は著名人の公知名であり生徒 PII ではない。**PII 列を足す変更は本特例（SELECT 全開放）の前提を壊すので
 * 不可**（その場合は ADR を改める）。外部送信が無いため Vertex AI マスキングの対象外。
 *
 * ## 列設計
 * 外部原文が無いため raw jsonb は持たず、必要十分な列で表現する:
 *   - `category`   … 名言 / 四字熟語 / 英単語 / 今日は何の日（snippet_category enum、ローテの軸）
 *   - `body`       … 主表示テキスト（名言の本文・四字熟語の語・英単語の語・記念日の名称）
 *   - `reading`    … 読み・発音（四字熟語の読み・英単語の発音記号 等。無ければ null）
 *   - `meaning`    … 意味・和訳・補足（四字熟語/英単語/記念日の説明。無ければ null）
 *   - `attribution`… 出典・著者（名言用。無ければ null）
 *   - `monthDay`   … 'MM-DD'。on_this_day 用（その日付に一致する行を選ぶ）。他カテゴリは null
 *   - `active`     … 論理無効化（誤情報の取り下げ等。false は表示候補から外す）
 *
 * ## 一意性（重複投入防止）
 * `(category, body)` で一意。同一カテゴリの同一本文を二重投入しない（seed の冪等再実行 ON CONFLICT 競合キー）。
 *
 * ## 監査（ルール1）
 * `auditColumns` を付与。seed / コンテンツ投入の書き込みは created_by/updated_by = null
 * （システム = `system://signage-snippets-seed`）。created_by/updated_by → users(id) の FK は循環依存回避のため
 * migrations/00NN で後付けする（_shared/audit.ts と 0029（警報）/ 0030（熱中症）と同じパターン）。
 *
 * 関連: ADR-019（RLS 二層 / 公開参照マスタ特例）, ADR-016（サイネージ匿名）, weather_warnings（公開型の先例）。
 * 新 ADR は不要（外部依存ゼロ・固定費ゼロ・既存の公開参照マスタ特例の踏襲のみ）。
 * 非スコープ（follow-up）: サイネージ盤面への表示結線（apps/web、別 PR）/ コンテンツ拡充（別 ops 作業）。
 */
export const signageSnippets = pgTable(
  "signage_snippets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // 表示カテゴリ（ローテの軸）。quote/idiom/word はローテ選択、on_this_day は month_day 一致で選択。
    category: snippetCategory("category").notNull(),
    // 主表示テキスト（名言の本文 / 四字熟語の語 / 英単語の語 / 記念日の名称）。長文になりうるため text。
    body: text("body").notNull(),
    // 読み・発音（四字熟語の読み・英単語の発音記号 等）。無ければ null。
    reading: varchar("reading", { length: 200 }),
    // 意味・和訳・補足（四字熟語/英単語/記念日の説明）。長文になりうるため text。無ければ null。
    meaning: text("meaning"),
    // 出典・著者（名言用。著名人の公知名であり生徒 PII ではない）。無ければ null。
    attribution: varchar("attribution", { length: 200 }),
    // 'MM-DD'（on_this_day 用。その日付に一致する行を選ぶ）。他カテゴリは null。長さ 5 固定。
    monthDay: varchar("month_day", { length: 5 }),
    // 論理無効化（誤情報の取り下げ等）。false は表示候補から外す。既定 true。
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => ({
    // 同一カテゴリの同一本文は重複投入しない（seed の冪等再実行 ON CONFLICT 競合キー）。
    uxCategoryBody: uniqueIndex("ux_signage_snippets_category_body").on(t.category, t.body),
  }),
);
