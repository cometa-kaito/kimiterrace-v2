import { XMLParser } from "fast-xml-parser";

/**
 * pattern2/3 サイネージ「工学ニュース」の **純粋 RSS パーサ**（ADR-043）。XML 文字列から
 * 「見出し（title）+ 出典 URL（link）+ 公開日時（pubDate / dc:date）」を抽出して正規化する。
 * ネットワーク非依存・副作用なしで単体テスト可能（weather の `jma.ts` / 鉄道の `meitetsu.ts` と同方針）。
 *
 * ## 著作権（ADR-043 の物理的担保）
 * **本文は一切読まない / 返さない。** title + url + publishedAt のメタのみ。著作権は事実を保護しないため、
 * 見出し + 出典 + リンクの紹介に留めることで全ソースを許諾なし・合法に表示できる（本文・PII を足さない）。
 *
 * ## 対応フォーマット（両方を 1 関数で正規化）
 *   - **RSS 2.0**: `rss > channel > item`、公開日は `<pubDate>`（RFC 822）。JST サイエンスポータル等。
 *   - **RSS 1.0 / RDF**: `rdf:RDF > item`、公開日は `<dc:date>`（ISO 8601）。文部科学省 index.rdf 等。
 *
 * ## fail-soft（NFR02 / ADR-043 §残存リスク②）
 * 政府系 / JST のフィードは無保証で構造が変わりうる。特定構造に強依存せず、
 * **取れたフィールドだけ防御的に読む**。壊れた XML / 未対応フォーマット / item ゼロでも throw せず空配列を返す
 * （呼び出し側の run.ts が「当該フィードのみ skip」して他フィードと last-known-good を壊さない）。
 */

/** 正規化済みの 1 記事（見出し + 出典のみ。本文は持たない）。 */
export type ParsedNewsItem = {
  /** 見出し（RSS の <title>）。空文字の記事は捨てる。 */
  title: string;
  /** 出典 URL（記事原文へのリンク）。空文字の記事は捨てる。 */
  url: string;
  /** 公開日時（pubDate / dc:date のパース結果）。解釈できなければ null。 */
  publishedAt: Date | null;
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
 * RSS の `<link>` を URL 文字列へ。多くは text だが、Atom 風の `<link href="...">` 属性形式も
 * 念のため拾う（防御的）。
 */
function asLink(v: unknown): string {
  const text = asText(v);
  if (text) {
    return text;
  }
  if (v && typeof v === "object") {
    const href = (v as Record<string, unknown>)["@_href"];
    if (typeof href === "string") {
      return href.trim();
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

/** 1 つの item ノードを ParsedNewsItem へ正規化する。title / url のどちらかが空なら null（捨てる）。 */
function normalizeItem(item: Record<string, unknown>): ParsedNewsItem | null {
  const title = asText(item.title).slice(0, MAX_TITLE_LEN);
  const url = asLink(item.link);
  if (!title || !url) {
    return null;
  }
  // RSS 2.0 = pubDate、RDF = dc:date。どちらか取れた方を使う（両方欠落は null = 表示は取得時刻順へ）。
  const publishedAt = parseDate(item.pubDate) ?? parseDate(item["dc:date"]);
  return { title, url, publishedAt };
}

/**
 * RSS 2.0 / RDF いずれかの XML 文字列をパースして記事配列を返す（純関数）。
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
