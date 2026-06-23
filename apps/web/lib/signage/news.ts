import { type NewsItem, type TenantTx, getLatestNews } from "@kimiterrace/db";

/**
 * pattern2/3「時事ニュース」サイネージ読み取り（ADR-043）。weather / railway と同じく **キャッシュ
 * （news_items）を読むだけ**で外部 RSS を直叩きしない（端末閉域・ADR-021 / ADR-035 の先例）。
 * 取得 Job（backend）が政府系 / JST の公開 RSS を upsert し、本層はそれを公開日降順で SELECT する。
 * RLS は `news_items_read_all`（USING true）なので匿名サイネージでも読める（school_id 非保持の公開・非 PII）。
 *
 * ## 著作権（ADR-043 §2026-06-20 改訂）
 * 表示するのは **見出し（title）+ 発表元（sourceLabel）+ 公開日（publishedAt）+ 出典 URL（url）**、加えて
 * **CC BY ソースの公式要約（summary・経産省 METI のみ非 null）**。要約の合法 gate は取得 Job（CC BY のみ保存）が
 * 済ませており、本層は読むだけ。**出典明記（発表元ラベル）は必須**（CC BY の条件かつ礼儀）。本文の転載はしない。
 *
 * ## 鮮度（railway-status.ts に倣う）
 * 取得 Job が一定時間更新していないと last-known-good が古くなりうる。盤面に「情報が古い可能性」を注記できる
 * よう、最新記事の取得時刻（fetchedAt）が `STALE_AFTER_MS` を超えたら `isStale=true` を立てる。
 */

/** これより古い（最新記事の取得時刻が古い）場合は鮮度低下とみなす（取得 Job 停止時の注記用・6 時間）。 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** 盤面に出す件数（最新 N 件）。盤面の小枠に収まる範囲（ADR-043「見出し+出典」リスト）。 */
const SIGNAGE_NEWS_LIMIT = 5;

/**
 * pattern3 廊下フッタ専用の取得件数。要約あり（METI）と見出しのみ（JST/文科省）の**両方**を確保するため
 * 表示件数より多めに引く（{@link getLatestNews} は要約あり優先ソートで先頭に METI が固まるので、見出しまで
 * 届く深さが要る）。補完運用に切り替わった時に最新の見出し記事を取りこぼさないための余裕。
 */
const PATTERN3_NEWS_FETCH_LIMIT = 12;

/**
 * pattern3 フッタで「要約あり記事のみ表示（本文ありのみ・2026-06-22 指定）」を維持してよい鮮度窓（48 時間）。
 * 要約あり（CC BY = 実質 経産省 METI）の最新**公開日**がこれより古いと、METI 発表が数日空いた（週末/閑散期）と
 * 判断し、JST・文科省の**見出しのみ記事も混ぜて鮮度を回復**する（不足時のみ見出し補完・2026-06-23 ユーザー
 * 確定）。fetchedAt（取得時刻）基準の {@link STALE_AFTER_MS} とは別軸（こちらは publishedAt 基準）。
 */
const PATTERN3_SUMMARY_FRESH_MS = 48 * 60 * 60 * 1000;

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
  /**
   * 公式が配信する要約（CC BY ソース = 経産省 METI のみ非 null・要許諾ソースは null）。pattern3 廊下フッタ
   * （要約優先＋不足時のみ見出し補完・#1156）と pattern4 が出典明記の上で箇条書き表示する（pattern2 は見出し
   * のみ。ADR-043 §2026-06-20 改訂・gate は取得 Job 側）。
   */
  summary: string | null;
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
 * news_items の行を盤面表示用 {@link SignageNews}（射影 + 鮮度フラグ）へ変換する内部ヘルパ。取得方針が異なる
 * 各取得関数（pattern2/4 = 最新 N 件 / pattern3 = 要約優先＋不足時補完）で**変換と鮮度判定を共有**する。
 * 記事無しは空リスト（fail-soft）。
 *
 * 鮮度（isStale）: 最新の**取得時刻**（fetchedAt の最大）が {@link STALE_AFTER_MS} を超えたら古い可能性とみなす
 * （公開日ではなく取得時刻基準＝取得 Job 停止の検知用。pattern3 の補完判定とは別軸）。
 */
function toSignageNews(rows: readonly NewsItem[], now: Date): SignageNews {
  if (rows.length === 0) {
    return { items: [], isStale: false };
  }
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
      summary: r.summary,
      publishedAt: r.publishedAt,
    })),
    isStale,
  };
}

/**
 * 最新の時事ニュース（見出し + 出典）を取得する（**pattern2/4 用**）。要約あり（METI）優先の最新 N 件を
 * そのまま返す。記事無し・取得失敗は空リスト（fail-soft、盤面を壊さない）。
 *
 * @param tx  テナント context tx（匿名サイネージ可・RLS read_all で読める）。
 * @param now 鮮度判定の基準時刻（既定は現在時刻）。
 */
export async function getSignageNews(tx: TenantTx, now: Date = new Date()): Promise<SignageNews> {
  return toSignageNews(await getLatestNews(tx, SIGNAGE_NEWS_LIMIT), now);
}

/**
 * **pattern3 廊下フッタ専用**の記事選別（純関数・要約あり優先＋不足時のみ見出し補完）。
 *
 * pattern3 のフッタは要約（本文）がある記事を 1 件ずつ自動送りする設計（2026-06-22 指定）だが、要約は CC BY
 * ソース（実質 経産省 METI）のみ非 null のため、METI の発表が数日空く（週末/閑散期）と廊下フッタが同じ記事で
 * 固定される（本番で 6/19 固定を観測・2026-06-23）。そこで:
 *
 * - **要約あり記事の最新公開が鮮度窓（{@link PATTERN3_SUMMARY_FRESH_MS}）内** → 従来どおり**要約あり記事のみ**
 *   （本文ありの統一感を維持）。
 * - **要約あり記事が古い / 無い** → JST・文科省の**見出しのみ記事も混ぜ、公開日降順**（最新を前へ）で返す
 *   ＝鮮度を回復する。要約があれば引き続き本文も出る（表示側 Pattern3NewsTicker が summary 有無で出し分け）。
 *
 * `rows` は {@link getLatestNews}（要約あり優先ソート）の戻りを想定。公開日 null は鮮度に数えず末尾扱い。
 */
export function pickPattern3NewsRows<
  T extends { readonly summary: string | null; readonly publishedAt: Date | null },
>(rows: readonly T[], now: Date, limit: number = SIGNAGE_NEWS_LIMIT): T[] {
  const hasSummary = (r: T): boolean =>
    typeof r.summary === "string" && r.summary.trim().length > 0;
  const withSummary = rows.filter(hasSummary);
  // 要約あり記事の最新公開時刻（publishedAt null は 0 = 鮮度に数えない）。
  const newestSummaryMs = withSummary.reduce((max, r) => {
    const t = r.publishedAt?.getTime() ?? 0;
    return t > max ? t : max;
  }, 0);
  const summaryFresh =
    newestSummaryMs > 0 && now.getTime() - newestSummaryMs <= PATTERN3_SUMMARY_FRESH_MS;
  if (summaryFresh) {
    // 通常運用: 要約あり記事のみ（従来の本文ありのみ表示を維持）。
    return withSummary.slice(0, limit);
  }
  // 補完運用: 要約あり記事が古い/無い → 見出しのみ記事も含め公開日降順（最新優先）で埋め、鮮度を回復する。
  return [...rows]
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    .slice(0, limit);
}

/**
 * **pattern3 廊下フッタ用**の時事ニュースを取得する。要約あり（METI）を主役にしつつ、要約あり記事が鮮度窓より
 * 古い/無い時だけ JST・文科省の見出しも混ぜて鮮度を回復する（{@link pickPattern3NewsRows}）。記事無し・取得
 * 失敗は空リスト（fail-soft）。
 *
 * @param tx  テナント context tx（匿名サイネージ可・RLS read_all で読める）。
 * @param now 鮮度判定・補完判定の基準時刻（既定は現在時刻）。
 */
export async function getSignagePattern3News(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<SignageNews> {
  const rows = await getLatestNews(tx, PATTERN3_NEWS_FETCH_LIMIT);
  return toSignageNews(pickPattern3NewsRows(rows, now), now);
}
