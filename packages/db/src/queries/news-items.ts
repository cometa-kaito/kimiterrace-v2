import { type InferSelectModel, desc, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TenantTx } from "../client.js";
import type { NewsSource } from "../_shared/enums.js";
import { newsItems } from "../schema/news-items.js";

/**
 * pattern2/3 サイネージ「工学ニュース」の見出しキャッシュ query 層（ADR-043）。weather_forecasts /
 * railway_status と同じ閉域パターン: 取得 Job が **system context で upsert**、サイネージは
 * **匿名コンテキストで read**（`news_items_read_all` USING(true)）。手書き WHERE school_id は書かない
 * （school_id 非保持の公開・非 PII テーブル、ADR-019 特例）。型は schema から派生（ルール3）。
 */

/** SELECT だけできれば良い接続（db / tx の両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;
type NewsItemRow = InferSelectModel<typeof newsItems>;
export type NewsItem = NewsItemRow;

/** 取得 Job が upsert する 1 記事の入力（見出し + 出典のみ。本文は持たない）。 */
export type UpsertNewsItemInput = {
  source: NewsSource;
  sourceLabel: string;
  title: string;
  url: string;
  category?: string | null;
  /**
   * 公式が配信する要約（CC BY ソースのみ非 null・要許諾ソースは null）。gate は取得 Job 側（run.ts の
   * `isSummaryAllowedSource`）が担い、本層はそのまま保存する（ADR-043 §2026-06-20 改訂）。
   */
  summary?: string | null;
  /** 記事の公開日時（RSS pubDate）。無ければ null。 */
  publishedAt?: Date | null;
  /** 取得時刻（未指定は now()）。 */
  fetchedAt?: Date;
};

/**
 * ニュース記事をまとめて upsert する（ON CONFLICT (source, url)）。**system context（取得 Job）で呼ぶ**
 * （`news_items_write_system` が role=system_admin を要求）。再取得時は見出し / 公開日 / 取得時刻 /
 * updated_at を差し替える（last-known-good 更新）。
 *
 * @returns INSERT ... RETURNING が返した行数（挿入 + 更新の合計）。
 */
export async function saveNewsItems(
  tx: TenantTx,
  items: readonly UpsertNewsItemInput[],
): Promise<number> {
  if (items.length === 0) {
    return 0;
  }
  const rows = await tx
    .insert(newsItems)
    .values(
      items.map((it) => ({
        source: it.source,
        sourceLabel: it.sourceLabel,
        title: it.title,
        url: it.url,
        category: it.category ?? null,
        summary: it.summary ?? null,
        publishedAt: it.publishedAt ?? null,
        ...(it.fetchedAt ? { fetchedAt: it.fetchedAt } : {}),
        createdBy: null,
        updatedBy: null,
      })),
    )
    .onConflictDoUpdate({
      target: [newsItems.source, newsItems.url],
      set: {
        sourceLabel: sql`excluded.source_label`,
        title: sql`excluded.title`,
        category: sql`excluded.category`,
        // 再取得時に要約も差し替える（CC BY 化で要約が後付けされた既存行も拾える。null 化も反映）。
        summary: sql`excluded.summary`,
        publishedAt: sql`excluded.published_at`,
        fetchedAt: sql`excluded.fetched_at`,
        // ルール1: 再取得時刻として updated_at を明示更新（created_at / created_by は初回値を保つ）。
        updatedAt: sql`now()`,
        updatedBy: sql`null`,
      },
    })
    .returning({ id: newsItems.id });
  return rows.length;
}

/**
 * 最新ニュースを**「要約付き（CC BY ソース）優先 → 公開日降順 → 取得時刻」**で最大 `limit` 件返す。
 * サイネージ匿名コンテキスト（role 未設定）でも `news_items_read_all`（USING true）により読める。
 * 該当が無ければ空配列（fail-soft）。
 *
 * ## 並び順（2026-06-20「METI 中心で全項目要約」ユーザー指示）
 * `summary` を持つ項目（＝CC BY ソース＝主に経産省 METI・ADR-043 §2026-06-20）を**先頭に寄せる**。
 * 単純な公開日降順だと説明文を持たない府省（文科省等）の直近大量公開が要約付き METI を `limit` 件外へ
 * 押し出し、盤面に要約が一切出ない事象が起きるため（本番 #1087 反映直後に観測）。要約付きを上位に固定し、
 * その中で公開日降順、要約無し（見出しのみの jst/mext）は後段で公開日降順に並べる。
 *
 * @param db    SELECT 可能な接続 / tx（匿名サイネージは school_id のみ or 無しで可）。
 * @param limit 返す最大件数（既定 8）。
 */
export async function getLatestNews(db: Selectable, limit = 8): Promise<NewsItem[]> {
  return db
    .select()
    .from(newsItems)
    .orderBy(
      // ① 要約付き（METI 等 CC BY）を先頭へ（true が先＝DESC）。② 公開日降順（NULL は末尾）。③ 取得時刻降順。
      sql`(${newsItems.summary} IS NOT NULL) DESC`,
      sql`${newsItems.publishedAt} DESC NULLS LAST`,
      desc(newsItems.fetchedAt),
    )
    .limit(limit);
}
