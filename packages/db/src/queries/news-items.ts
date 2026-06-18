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
 * 最新ニュースを公開日時の降順（公開日が無ければ取得時刻順）に最大 `limit` 件返す。
 * サイネージ匿名コンテキスト（role 未設定）でも `news_items_read_all`（USING true）により読める。
 * 該当が無ければ空配列（fail-soft）。
 *
 * @param db    SELECT 可能な接続 / tx（匿名サイネージは school_id のみ or 無しで可）。
 * @param limit 返す最大件数（既定 8）。
 */
export async function getLatestNews(db: Selectable, limit = 8): Promise<NewsItem[]> {
  return (
    db
      .select()
      .from(newsItems)
      // 公開日 NULL は末尾へ（取得時刻で代替整列）。
      .orderBy(sql`${newsItems.publishedAt} DESC NULLS LAST`, desc(newsItems.fetchedAt))
      .limit(limit)
  );
}
