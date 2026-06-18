import {
  type TenantTx,
  type UpsertNewsItemInput,
  createDbClient,
  saveNewsItems,
  withTenantContext,
} from "@kimiterrace/db";
import { type ParsedNewsItem, parseNewsFeed } from "./news-parse.js";

/**
 * pattern2/3 サイネージ「工学ニュース」取得バッチの **オーケストレーション + I/O 結線**（ADR-043）。
 * weather の run.ts / 鉄道の run.ts と同方針で、純粋ロジック（パース = `news-parse.ts`）と I/O（fetch / DB）を
 * 分け、依存注入でネットワーク・DB なしに `runNewsFetch` を単体検証できる。
 *
 * - **閉域 / PII 非送信（ADR-043）**: 外部 egress は本 Job だけ。サイネージ端末は DB キャッシュ（news_items）を
 *   読むだけで RSS を直叩きしない。各機関フィードへは GET のみで個人情報を送らない。
 * - **著作権（ADR-043）**: 取得・保存するのは見出し + 出典 URL + 公開日のみ（本文非転載）。
 * - **テナント分離（ルール2）**: upsert は system_admin context（`news_items_write_system` policy）。
 *   BYPASSRLS は使わない。`news_items` は school_id 非保持の公開キャッシュ（ADR-019 特例）。
 * - **fail-soft（NFR02）**: 1 フィードの取得 / パース失敗は **当該フィードのみ skip**。他フィードと既存
 *   キャッシュ（last-known-good）は壊さない。全フィード失敗のみ entrypoint が非ゼロ終了に使う。
 */

/** 取得対象フィードの定義（source enum 値 + 表示名 + RSS URL）。 */
export interface NewsFeed {
  /** news_items.source の enum 値（"jst" | "mext" | "meti"）。型は UpsertNewsItemInput から借りる。 */
  source: UpsertNewsItemInput["source"];
  /** 出典明記用の表示名（例「JST サイエンスポータル」「文部科学省」）。 */
  sourceLabel: string;
  /** フィード URL（RSS 2.0 または RDF）。 */
  url: string;
}

/**
 * 確定フィード（デフォルト 2 本、ADR-043 §決定）。env `NEWS_FEEDS_JSON` で上書き可（鉄道の RAILWAY_STATUS_URL
 * 方式・URL 変化や追加に追従）。
 *   - jst  = JST サイエンスポータル（RSS 2.0・本命・工学/科学技術・日次更新）
 *   - mext = 文部科学省 news/index.rdf（RDF・CC BY 互換・補助）
 * meti（経済産業省）は **URL 未確定のためデフォルトに入れない**（enum 値 "meti" は存在するので、確定後に
 *   NEWS_FEEDS_JSON で追加できる。例: [{"source":"meti","sourceLabel":"経済産業省","url":"https://..."}]）。
 */
export const DEFAULT_NEWS_FEEDS: readonly NewsFeed[] = [
  {
    source: "jst",
    sourceLabel: "JST サイエンスポータル",
    url: "https://scienceportal.jst.go.jp/feed/rss.xml",
  },
  {
    source: "mext",
    sourceLabel: "文部科学省",
    url: "https://www.mext.go.jp/b_menu/news/index.rdf",
  },
];

/** 1 フィードあたり最新何件を upsert するか（ADR-043 §決定: 10〜15 件程度）。 */
export const MAX_ITEMS_PER_FEED = 15;

/** `runNewsFetch` の依存（fetch / DB を注入してネットワーク・DB なしで検証可能にする）。 */
export interface NewsFetchDeps {
  /** 取得対象フィード一覧（実体は DEFAULT_NEWS_FEEDS または NEWS_FEEDS_JSON）。 */
  listFeeds(): NewsFeed[];
  /** 1 フィードを取得・パースする（実体は HTTP fetch + `parseNewsFeed`）。失敗は throw（呼び出し側が捕捉）。 */
  fetchFeed(feed: NewsFeed): Promise<ParsedNewsItem[]>;
  /** パース済み記事群を news_items に upsert する（実体は system_admin context の `saveNewsItems`）。 */
  saveItems(items: readonly UpsertNewsItemInput[]): Promise<number>;
}

/** バッチ全体のサマリ（Cloud Logging に構造化ログ。secret / PII は含めない）。 */
export interface NewsFetchSummary {
  /** 取得対象フィード数。 */
  feeds: number;
  /** 取得・パースに成功したフィード数。 */
  fetchedFeeds: number;
  /** upsert した行数（全フィード合算・挿入 + 更新）。 */
  rowsUpserted: number;
  /** 取得失敗したフィード数（既存キャッシュは消さない = last-known-good 維持）。0 が正常。 */
  failed: number;
  /** 取得失敗したフィードの source 値（監視・Sentry 用。PII でない公開ラベル）。 */
  failedFeeds: string[];
}

/**
 * 工学ニュース取得バッチ本体（純粋オーケストレーション、fetch/DB は注入）。
 *
 * 1 フィードの取得 / パース / 保存失敗は **そのフィードだけ skip** し、他フィードは続行する（fail-soft）。
 * 失敗フィードの既存キャッシュは触らないので last-known-good を維持する（ADR-043 §決定 / NFR02）。
 * 全失敗でも例外は投げず summary を返し、呼び出し側（entrypoint）が failed / fetchedFeeds で WARN・非ゼロ終了を判断する。
 */
export async function runNewsFetch(deps: NewsFetchDeps): Promise<NewsFetchSummary> {
  const feeds = deps.listFeeds();
  let fetchedFeeds = 0;
  let rowsUpserted = 0;
  const failedFeeds: string[] = [];

  for (const feed of feeds) {
    try {
      const parsed = await deps.fetchFeed(feed);
      const items: UpsertNewsItemInput[] = parsed.map((p) => ({
        source: feed.source,
        sourceLabel: feed.sourceLabel,
        title: p.title,
        url: p.url,
        publishedAt: p.publishedAt,
      }));
      const rows = await deps.saveItems(items);
      fetchedFeeds += 1;
      rowsUpserted += rows;
    } catch {
      // 取得 / 保存失敗はそのフィードのみ skip（既存キャッシュを last-known-good として残す）。
      failedFeeds.push(feed.source);
    }
  }

  return {
    feeds: feeds.length,
    fetchedFeeds,
    rowsUpserted,
    failed: failedFeeds.length,
    failedFeeds,
  };
}

/** HTTP 取得の設定（HTTP マナー: User-Agent / timeout）。 */
export interface HttpFetchConfig {
  /** 明示 User-Agent（連絡先を含めて各機関に対し礼儀正しく。ADR-043 §低頻度・礼儀）。 */
  userAgent: string;
  /** タイムアウト（ms）。既定 10s。 */
  timeoutMs?: number;
  /** 1 フィードあたり取得件数の上限（既定 MAX_ITEMS_PER_FEED）。 */
  maxItems?: number;
  /** テスト差し替え用の fetch 実装（既定は global fetch）。 */
  fetchImpl?: typeof fetch;
}

/**
 * 1 フィードを HTTP 取得しパースする（実 I/O）。timeout / 明示 User-Agent を付ける。
 * 非 2xx・タイムアウトは throw（`runNewsFetch` がフィード単位で捕捉して skip）。
 * パース不能（壊れ XML 等）は `parseNewsFeed` が空配列を返す（throw しない）。
 */
export async function fetchNewsFeed(
  feed: NewsFeed,
  config: HttpFetchConfig,
): Promise<ParsedNewsItem[]> {
  const fetchImpl = config.fetchImpl ?? fetch;
  // `?? 10_000` は nullish のみ。NaN（非数値 env 由来）は素通りし `setTimeout(abort, NaN)` ≒ 即 abort に
  // なるため、有限値でなければ既定 10s に倒す（多層防御、weather/railway と同方針）。
  const timeoutMs = Number.isFinite(config.timeoutMs) ? (config.timeoutMs as number) : 10_000;
  const maxItems = config.maxItems ?? MAX_ITEMS_PER_FEED;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(feed.url, {
      method: "GET",
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/rss+xml, application/rdf+xml, application/xml, text/xml",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ニュース取得失敗: source=${feed.source} status=${res.status}`);
    }
    const xml = await res.text();
    return parseNewsFeed(xml, maxItems);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * env `NEWS_FEEDS_JSON`（JSON 配列）からフィード定義を読む。未設定 / 不正なら null（呼び出し側が
 * `DEFAULT_NEWS_FEEDS` にフォールバック）。要素は { source, sourceLabel, url } を満たす必要がある。
 * source は enum 値（jst/mext/meti）のみ許可。これ以外の文字列は捨てる（壊れ env で全断しない）。
 */
export function parseFeedsEnv(raw: string | undefined): NewsFeed[] | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const allowedSources = new Set<string>(["jst", "mext", "meti"]);
  const feeds: NewsFeed[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const source = typeof e.source === "string" ? e.source : "";
    const sourceLabel = typeof e.sourceLabel === "string" ? e.sourceLabel.trim() : "";
    const url = typeof e.url === "string" ? e.url.trim() : "";
    if (allowedSources.has(source) && sourceLabel && url) {
      feeds.push({ source: source as NewsFeed["source"], sourceLabel, url });
    }
  }
  // 空配列（全要素が不正）なら null 扱いでデフォルトに倒す（誤設定で 0 フィードにしない）。
  return feeds.length > 0 ? feeds : null;
}

/** 実行時の設定（DB 接続 / User-Agent。DATABASE_URL は Secret Manager 経由、ルール5）。 */
export interface RunNewsFetchConfig {
  /** DB 接続文字列（kimiterrace_app ロール）。Secret Manager 経由で注入（ルール5）。 */
  databaseUrl: string;
  /** 各機関への明示 User-Agent（連絡先を含める。ADR-043 §礼儀）。 */
  userAgent: string;
  /** HTTP タイムアウト（ms）。 */
  timeoutMs?: number;
  /** フィード定義（未指定は DEFAULT_NEWS_FEEDS。env NEWS_FEEDS_JSON 由来を entrypoint が渡す）。 */
  feeds?: readonly NewsFeed[];
  /** 1 フィードあたり取得件数の上限（既定 MAX_ITEMS_PER_FEED）。 */
  maxItems?: number;
  /** テスト用: BYPASSRLS 接続をアプリロールへ降格する SET LOCAL ROLE 先。本番は未指定。 */
  appRole?: string;
}

/**
 * 実 PG + 各機関 RSS で工学ニュース取得バッチを実行する。接続は本関数が開き、終了時に必ず閉じる。
 * env 読取・プロセス終了コードは entrypoint（`news-job.ts`）が担う（weather / railway と同じ分離）。
 */
export async function runNewsFetchBatch(config: RunNewsFetchConfig): Promise<NewsFetchSummary> {
  const { sql, db } = createDbClient(config.databaseUrl);
  const appRoleOptions = config.appRole !== undefined ? { appRole: config.appRole } : {};
  const feeds = config.feeds && config.feeds.length > 0 ? config.feeds : DEFAULT_NEWS_FEEDS;
  const httpConfig: HttpFetchConfig = {
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    maxItems: config.maxItems,
  };
  try {
    return await runNewsFetch({
      listFeeds: () => [...feeds],
      fetchFeed: (feed) => fetchNewsFeed(feed, httpConfig),
      // upsert は system_admin context（news_items_write_system policy が書込みを system に限定）。
      saveItems: (items) =>
        withTenantContext(
          db,
          { role: "system_admin" },
          (tx: TenantTx) => saveNewsItems(tx, items),
          appRoleOptions,
        ),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
