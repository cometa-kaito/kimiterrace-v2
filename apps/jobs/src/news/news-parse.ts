import { XMLParser } from "fast-xml-parser";

/**
 * pattern2/3 サイネージ「工学ニュース」の **純粋 RSS パーサ**（ADR-043）。XML 文字列から
 * 「見出し（title）+ 出典 URL（link）+ 公開日時（pubDate / dc:date）」を抽出して正規化する。
 * ネットワーク非依存・副作用なしで単体テスト可能（weather の `jma.ts` / 鉄道の `meitetsu.ts` と同方針）。
 *
 * ## 著作権（ADR-043 §2026-06-20 改訂）
 * 抽出するのは title + url + publishedAt + summary。著作権は事実を保護しないため見出し + 出典は全ソース合法。
 * **summary（公式配信の要約・description）は「取れたら入れる」**だけで、ソース別の合法 gate は後段（run.ts の
 * `isSummaryAllowedSource`）が担う。本パーサは法判定を持たず、CC BY ソース（METI = PDL1.0）の要約のみが最終的に
 * 保存・表示される（要許諾ソースの description は run.ts が破棄）。
 *
 * ## 対応フォーマット（1 関数で正規化）
 *   - **RSS 2.0**: `rss > channel > item`、公開日は `<pubDate>`（RFC 822）、要約は `<description>`。JST 等。
 *   - **RSS 1.0 / RDF**: `rdf:RDF > item`、公開日は `<dc:date>`（ISO 8601）、要約は `<description>` / `<dc:description>`。文科省 index.rdf 等。
 *   - **Atom**: `feed > entry`、見出しは `<title>`、URL は `<link rel="alternate" href>`、公開日は `<updated>`、要約は `<summary>`。経産省 METI 等。
 *
 * ## fail-soft（NFR02 / ADR-043 §残存リスク②）
 * 政府系 / JST のフィードは無保証で構造が変わりうる。特定構造に強依存せず、
 * **取れたフィールドだけ防御的に読む**。壊れた XML / 未対応フォーマット / item ゼロでも throw せず空配列を返す
 * （呼び出し側の run.ts が「当該フィードのみ skip」して他フィードと last-known-good を壊さない）。
 */

/** 正規化済みの 1 記事（見出し + 出典 + 任意の公式要約）。 */
export type ParsedNewsItem = {
  /** 見出し（RSS の <title>）。空文字の記事は捨てる。 */
  title: string;
  /** 出典 URL（記事原文へのリンク）。空文字の記事は捨てる。 */
  url: string;
  /** 公開日時（pubDate / dc:date / updated のパース結果）。解釈できなければ null。 */
  publishedAt: Date | null;
  /**
   * 公式が配信する要約（Atom `<summary>` / RSS `<description>`）。HTML タグ除去・trim・最大長で丸める。
   * 取れなければ null。**合法 gate は run.ts（CC BY ソースのみ採用）が担う**ので、ここでは取れたら入れる。
   */
  summary: string | null;
};

// 属性も拾えるようにしつつ（将来 <link href> 形式に備える）、値は trim する。XML パースで例外を投げさせない。
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  // CDATA / 数値風タイトル（"2026" 等）を文字列のまま保つ（型ブレ防止）。
  parseTagValue: false,
});

/** タイトルが見出しの最大長を超えたら丸める（schema の title varchar(300) に合わせる）。 */
const MAX_TITLE_LEN = 300;

/** 要約の最大長。盤面に収める想定で長文 description を丸める（schema の summary は text で無制限だが盤面都合）。 */
const MAX_SUMMARY_LEN = 400;

/** 単一要素 / 配列 / 欠損のいずれでも配列に正規化する（fast-xml-parser は item 1 件だと配列にしない）。 */
function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) {
    return [];
  }
  return Array.isArray(v) ? v : [v];
}

/**
 * RSS のテキストノードを文字列へ。fast-xml-parser は text-only 要素を string、属性付き要素を
 * `{ "#text": "...", "@_..." : ... }` で返すため両方を吸う。数値/真偽は文字列化する。
 */
function asText(v: unknown): string {
  if (v === undefined || v === null) {
    return "";
  }
  if (typeof v === "string") {
    return v.trim();
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (typeof v === "object") {
    const node = v as Record<string, unknown>;
    if (typeof node["#text"] === "string") {
      return node["#text"].trim();
    }
    if (typeof node["#text"] === "number") {
      return String(node["#text"]);
    }
  }
  return "";
}

/**
 * `<link>` を URL 文字列へ。RSS 2.0/RDF はテキスト（`<link>https://…</link>`）、Atom は属性形式
 * （`<link rel="alternate" href="…">`）。Atom は entry に複数 `<link>`（alternate / self / enclosure）を
 * 持ちうるので配列も受け、**rel="alternate" を優先**し、無ければ最初の href を使う（防御的）。
 */
function asLink(v: unknown): string {
  const text = asText(v);
  if (text) {
    return text;
  }
  // Atom: 単一 link オブジェクト or link 配列。href 属性を読む（alternate を優先）。
  const candidates = toArray(v).filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object",
  );
  const hrefOf = (e: Record<string, unknown>): string =>
    typeof e["@_href"] === "string" ? (e["@_href"] as string).trim() : "";
  const alternate = candidates.find((e) => e["@_rel"] === "alternate");
  if (alternate) {
    const href = hrefOf(alternate);
    if (href) {
      return href;
    }
  }
  for (const e of candidates) {
    // rel 未指定（Atom 既定 = alternate）または他種別でも、最初に href を持つものを fallback で使う。
    if (e["@_rel"] === undefined || e["@_rel"] === "alternate") {
      const href = hrefOf(e);
      if (href) {
        return href;
      }
    }
  }
  // 最後の保険: rel を問わず最初の href（self しかない等の壊れフィードでも URL を拾う）。
  for (const e of candidates) {
    const href = hrefOf(e);
    if (href) {
      return href;
    }
  }
  return "";
}

/**
 * pubDate（RFC 822）/ dc:date（ISO 8601）を `Date` へ。空 / 解釈不能 / Invalid Date は null。
 * `new Date(string)` は RFC 822・ISO 8601 のいずれも解釈できる（実フィードはこのどちらか）。
 */
function parseDate(raw: unknown): Date | null {
  const s = asText(raw);
  if (!s) {
    return null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 要約（Atom `<summary>` / RSS `<description>` / `<dc:description>`）を正規化する。HTML タグ・実体参照の名残を
 * 落とし、空白を畳んで trim、最大長で丸める。空 / 取れない場合は null。合法 gate（CC BY のみ採用）は run.ts。
 */
function parseSummary(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const raw = asText(c);
    if (!raw) {
      continue;
    }
    // ニュース description はしばしば <p> 等の HTML を含む。タグを除去し連続空白を 1 個に畳む。
    const cleaned = raw
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) {
      return cleaned.slice(0, MAX_SUMMARY_LEN);
    }
  }
  return null;
}

/** 1 つの item / entry ノードを ParsedNewsItem へ正規化する。title / url のどちらかが空なら null（捨てる）。 */
function normalizeItem(item: Record<string, unknown>): ParsedNewsItem | null {
  const title = asText(item.title).slice(0, MAX_TITLE_LEN);
  // RSS 2.0/RDF = <link> テキスト、Atom = <link rel="alternate" href>。asLink が text/href の両方を吸う。
  const url = asLink(item.link);
  if (!title || !url) {
    return null;
  }
  // RSS 2.0 = pubDate、RDF = dc:date、Atom = updated。取れた方を使う（全欠落は null = 表示は取得時刻順へ）。
  const publishedAt =
    parseDate(item.pubDate) ?? parseDate(item["dc:date"]) ?? parseDate(item.updated);
  // 要約: Atom <summary> / RSS <description> / RDF <dc:description>。取れたら入れる（gate は run.ts）。
  const summary = parseSummary(item.summary, item.description, item["dc:description"]);
  return { title, url, publishedAt, summary };
}

/**
 * RSS 2.0 / RDF / Atom いずれかの XML 文字列をパースして記事配列を返す（純関数）。
 * `limit` を指定すると先頭から最大件数で打ち切る（フィードは通常新しい順）。
 * 壊れた XML / 未対応フォーマット / 0 件は **空配列**（throw しない、fail-soft）。
 */
export function parseNewsFeed(xml: string, limit?: number): ParsedNewsItem[] {
  if (!xml || xml.trim().length === 0) {
    return [];
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    // XML 不正は当該フィードのみ skip（空を返す）。run.ts が他フィード / last-known-good を壊さない。
    return [];
  }
  if (!doc || typeof doc !== "object") {
    return [];
  }

  // RSS 2.0: rss > channel > item。channel が配列のケースも防御的に畳む。
  const rss = doc.rss as Record<string, unknown> | undefined;
  const rdf = (doc["rdf:RDF"] ?? doc.RDF) as Record<string, unknown> | undefined;
  // Atom: feed > entry。経産省 METI（ml_index_release_atom.xml）等。要約は <summary>、URL は <link href>。
  const atom = doc.feed as Record<string, unknown> | undefined;

  let rawItems: unknown[] = [];
  if (rss && typeof rss === "object") {
    for (const channel of toArray(rss.channel as unknown)) {
      if (channel && typeof channel === "object") {
        rawItems = rawItems.concat(toArray((channel as Record<string, unknown>).item));
      }
    }
  } else if (rdf && typeof rdf === "object") {
    // RSS 1.0 / RDF: item は rdf:RDF 直下（channel と兄弟）。
    rawItems = toArray(rdf.item);
  } else if (atom && typeof atom === "object") {
    // Atom: entry は feed 直下。normalizeItem が title/link(href)/updated/summary を吸う。
    rawItems = toArray(atom.entry);
  }

  const out: ParsedNewsItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const item = normalizeItem(raw as Record<string, unknown>);
    if (item) {
      out.push(item);
    }
    if (limit !== undefined && out.length >= limit) {
      break;
    }
  }
  return out;
}
