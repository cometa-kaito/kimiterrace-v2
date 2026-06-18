import { type TenantTx, getLatestNews } from "@kimiterrace/db";

/**
 * pattern2/3「工学ニュース」サイネージ読み取り（ADR-043）。weather / railway と同じく **キャッシュ
 * （news_items）を読むだけ**で外部 RSS を直叩きしない（端末閉域・ADR-021 / ADR-035 の先例）。
 * 取得 Job（backend）が政府系 / JST の公開 RSS を upsert し、本層はそれを公開日降順で SELECT する。
 * RLS は `news_items_read_all`（USING true）なので匿名サイネージでも読める（school_id 非保持の公開・非 PII）。
 *
 * ## 著作権（ADR-043 の物理的担保）
 * 表示するのは **見出し（title）+ 発表元（sourceLabel）+ 公開日（publishedAt）+ 出典 URL（url）** のみ。
 * **本文は持たない**（news_items 自体が本文列を持たない）ので転載リスクは無いが、**出典明記（発表元ラベル）は
 * 必須**（CC BY の条件かつ礼儀）。
 *
 * ## 鮮度（railway-status.ts に倣う）
 * 取得 Job が一定時間更新していないと last-known-good が古くなりうる。盤面に「情報が古い可能性」を注記できる
 * よう、最新記事の取得時刻（fetchedAt）が `STALE_AFTER_MS` を超えたら `isStale=true` を立てる。
 */

/** これより古い（最新記事の取得時刻が古い）場合は鮮度低下とみなす（取得 Job 停止時の注記用・6 時間）。 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** 盤面に出す件数（最新 N 件）。盤面の小枠に収まる範囲（ADR-043「見出し+出典」リスト）。 */
const SIGNAGE_NEWS_LIMIT = 5;

/** サイネージ盤面に出す 1 記事（表示専用の射影。見出し + 出典のみ・本文は持たない）。 */
export type SignageNewsItem = {
  /** 一意キー（React の list key / 重複排除用）。 */
  id: string;
  /** 見出し（RSS の <title>）。本文は転載しない（ADR-043）。 */
  title: string;
  /** 発表元の表示名（出典明記用。例「JST サイエンスポータル」）。**必須表示**。 */
  sourceLabel: string;
  /** 出典 URL（記事原文へのリンク / QR 生成元）。 */
  url: string;
  /** 公開日時（RSS の pubDate）。無ければ null。 */
  publishedAt: Date | null;
};

/** ニュース全体のメタ（鮮度注記用）。記事リストと鮮度フラグをまとめる。 */
export type SignageNews = {
  /** 表示する記事（公開日降順・最大 {@link SIGNAGE_NEWS_LIMIT} 件）。空配列もありうる。 */
  items: SignageNewsItem[];
  /** 取得 Job が一定時間更新していない（最新記事の取得時刻が古い）。注記表示に使う。 */
  isStale: boolean;
};

/**
 * 最新の工学ニュース（見出し + 出典）を取得する。記事無し・取得失敗は空リスト（fail-soft、盤面を壊さない）。
 *
 * @param tx  テナント context tx（匿名サイネージ可・RLS read_all で読める）。
 * @param now 鮮度判定の基準時刻（既定は現在時刻）。
 */
export async function getSignageNews(tx: TenantTx, now: Date = new Date()): Promise<SignageNews> {
  const rows = await getLatestNews(tx, SIGNAGE_NEWS_LIMIT);
  if (rows.length === 0) {
    return { items: [], isStale: false };
  }
  // 鮮度: 最新の取得時刻（fetchedAt の最大）が STALE_AFTER_MS を超えたら古い可能性とみなす。
  const newestFetchedAt = rows.reduce(
    (max, r) => (r.fetchedAt.getTime() > max ? r.fetchedAt.getTime() : max),
    0,
  );
  const isStale = now.getTime() - newestFetchedAt > STALE_AFTER_MS;
  return {
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      sourceLabel: r.sourceLabel,
      url: r.url,
      publishedAt: r.publishedAt,
    })),
    isStale,
  };
}
