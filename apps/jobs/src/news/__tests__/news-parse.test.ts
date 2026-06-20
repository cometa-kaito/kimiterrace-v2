import { describe, expect, it } from "vitest";
import { parseNewsFeed } from "../news-parse.js";

/**
 * 時事ニュース RSS/Atom パーサ（ADR-043）の単体テスト。RSS 2.0（channel/item, pubDate）/ RSS 1.0/RDF
 * （rdf:RDF/item, dc:date）/ Atom（feed/entry, link href, updated, summary）を fixture で正規化し、
 * 見出し + URL + 公開日 + 要約（description / summary）を抽出すること、欠損 / 壊れ XML / 空でも throw せず
 * 取れた分だけ返す fail-soft を確認する（鉄道 meitetsu.test / 天気 jma.test 相当）。
 */

/** JST サイエンスポータル相当の RSS 2.0 fixture（縮約・近似）。 */
const RSS2_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>JST サイエンスポータル</title>
    <link>https://scienceportal.jst.go.jp/</link>
    <item>
      <title>新材料で太陽電池の効率が向上</title>
      <link>https://scienceportal.jst.go.jp/news/20260601_a01/</link>
      <pubDate>Mon, 01 Jun 2026 09:00:00 +0900</pubDate>
    </item>
    <item>
      <title>ロボット制御の新手法を開発</title>
      <link>https://scienceportal.jst.go.jp/news/20260531_b02/</link>
      <pubDate>Sun, 31 May 2026 12:30:00 +0900</pubDate>
    </item>
  </channel>
</rss>`;

/** 文部科学省 index.rdf 相当の RSS 1.0 / RDF fixture（縮約・近似）。 */
const RDF_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://www.mext.go.jp/">
    <title>文部科学省</title>
    <link>https://www.mext.go.jp/</link>
  </channel>
  <item rdf:about="https://www.mext.go.jp/b_menu/houdou/20260602.htm">
    <title>令和8年度の理科教育支援について</title>
    <link>https://www.mext.go.jp/b_menu/houdou/20260602.htm</link>
    <dc:date>2026-06-02T10:00:00+09:00</dc:date>
  </item>
  <item rdf:about="https://www.mext.go.jp/b_menu/houdou/20260601.htm">
    <title>高校工業科のカリキュラム改訂</title>
    <link>https://www.mext.go.jp/b_menu/houdou/20260601.htm</link>
    <dc:date>2026-06-01T08:00:00+09:00</dc:date>
  </item>
</rdf:RDF>`;

/** 経産省 ml_index_release_atom.xml 相当の Atom fixture（縮約・近似）。<summary> = 公式要約。 */
const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>経済産業省</title>
  <link rel="self" href="https://www.meti.go.jp/ml_index_release_atom.xml"/>
  <entry>
    <title>物流分野の優良事業者を募集します</title>
    <link rel="alternate" href="https://www.meti.go.jp/press/2026/06/20260620001/20260620001.html"/>
    <updated>2026-06-20T10:00:00+09:00</updated>
    <summary>経済産業省・国土交通省では、物流分野における優良事業者を募集します。令和8年12月に表彰式を予定しています。</summary>
  </entry>
  <entry>
    <title>再エネ導入支援の公募を開始</title>
    <link rel="alternate" href="https://www.meti.go.jp/press/2026/06/20260619001/20260619001.html"/>
    <updated>2026-06-19T09:00:00+09:00</updated>
    <summary>再生可能エネルギーの導入を支援する補助金の公募を開始しました。</summary>
  </entry>
</feed>`;

describe("parseNewsFeed", () => {
  it("RSS 2.0: channel/item を正規化し pubDate を Date にする（description 無しは summary=null）", () => {
    const items = parseNewsFeed(RSS2_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "新材料で太陽電池の効率が向上",
      url: "https://scienceportal.jst.go.jp/news/20260601_a01/",
      publishedAt: new Date("Mon, 01 Jun 2026 09:00:00 +0900"),
      summary: null,
    });
    expect(items[1]?.title).toBe("ロボット制御の新手法を開発");
    expect(items[1]?.publishedAt?.toISOString()).toBe(
      new Date("2026-05-31T12:30:00+09:00").toISOString(),
    );
  });

  it("RSS 1.0 / RDF: rdf:RDF 直下の item を正規化し dc:date を Date にする", () => {
    const items = parseNewsFeed(RDF_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "令和8年度の理科教育支援について",
      url: "https://www.mext.go.jp/b_menu/houdou/20260602.htm",
      publishedAt: new Date("2026-06-02T10:00:00+09:00"),
      summary: null,
    });
    expect(items[1]?.title).toBe("高校工業科のカリキュラム改訂");
  });

  it("Atom: feed/entry を正規化し link(href)/updated/summary を抽出する（経産省 METI 形式）", () => {
    const items = parseNewsFeed(ATOM_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "物流分野の優良事業者を募集します",
      url: "https://www.meti.go.jp/press/2026/06/20260620001/20260620001.html",
      publishedAt: new Date("2026-06-20T10:00:00+09:00"),
      summary:
        "経済産業省・国土交通省では、物流分野における優良事業者を募集します。令和8年12月に表彰式を予定しています。",
    });
    expect(items[1]?.title).toBe("再エネ導入支援の公募を開始");
    expect(items[1]?.summary).toBe(
      "再生可能エネルギーの導入を支援する補助金の公募を開始しました。",
    );
  });

  it("Atom: link が複数（self/alternate）でも rel=alternate の href を URL に使う", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>複数リンクの記事</title>
      <link rel="self" href="https://meti/self"/>
      <link rel="alternate" href="https://meti/article/1"/>
      <updated>2026-06-20T00:00:00Z</updated>
    </entry></feed>`;
    const items = parseNewsFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://meti/article/1");
  });

  it("RSS 2.0: description を summary に拾い HTML タグを除去して trim する", () => {
    const xml = `<rss version="2.0"><channel><item>
      <title>説明付き記事</title>
      <link>https://a/1</link>
      <description>&lt;p&gt;前半の文。&lt;/p&gt;  後半の文。</description>
    </item></channel></rss>`;
    const items = parseNewsFeed(xml);
    expect(items).toHaveLength(1);
    // HTML タグ（実体参照経由で復元された <p>）は除去し連続空白を畳む。
    expect(items[0]?.summary).toBe("前半の文。 後半の文。");
  });

  it("要約が欠落 / 空白のみなら summary=null", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>要約なし</title>
      <link rel="alternate" href="https://meti/x"/>
      <summary>   </summary>
    </entry></feed>`;
    const items = parseNewsFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.summary).toBeNull();
  });

  it("item が 1 件でも配列に正規化する（fast-xml-parser は単一要素を配列にしない）", () => {
    const single = `<rss version="2.0"><channel><item><title>単一記事</title><link>https://a/1</link></item></channel></rss>`;
    const items = parseNewsFeed(single);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("単一記事");
    expect(items[0]?.publishedAt).toBeNull(); // 公開日欠落は null
  });

  it("公開日欠落 / 解釈不能な日付は publishedAt=null（捨てない）", () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>日付なし</title><link>https://a/1</link></item>
      <item><title>不正日付</title><link>https://a/2</link><pubDate>not-a-date</pubDate></item>
    </channel></rss>`;
    const items = parseNewsFeed(xml);
    expect(items).toHaveLength(2);
    expect(items[0]?.publishedAt).toBeNull();
    expect(items[1]?.publishedAt).toBeNull();
  });

  it("title / link が欠落した item は捨てる（防御的）", () => {
    const xml = `<rss version="2.0"><channel>
      <item><link>https://a/1</link></item>
      <item><title>見出しのみ</title></item>
      <item><title>正常</title><link>https://a/3</link></item>
    </channel></rss>`;
    const items = parseNewsFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "正常", url: "https://a/3" });
  });

  it("limit で先頭から打ち切る", () => {
    const items = parseNewsFeed(RSS2_FIXTURE, 1);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("新材料で太陽電池の効率が向上");
  });

  it("壊れた XML は throw せず空配列を返す（fail-soft）", () => {
    expect(parseNewsFeed("<rss><channel><item><title>未閉じ")).toEqual([]);
  });

  it("空文字 / 空白のみ / item ゼロは空配列を返す", () => {
    expect(parseNewsFeed("")).toEqual([]);
    expect(parseNewsFeed("   \n  ")).toEqual([]);
    expect(parseNewsFeed(`<rss version="2.0"><channel><title>空</title></channel></rss>`)).toEqual(
      [],
    );
  });

  it("未対応フォーマット（rss/rdf/atom のいずれでもない）は空配列", () => {
    // html ルート等、3 形式どれにもマッチしないものは空（fail-soft）。
    expect(parseNewsFeed(`<html><body><h1>x</h1></body></html>`)).toEqual([]);
    // Atom だが entry に link が無い（URL 欠落）→ 当該記事は捨てられ 0 件。
    expect(
      parseNewsFeed(
        `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>x</title></entry></feed>`,
      ),
    ).toEqual([]);
  });

  it("CDATA で囲まれた見出しを読む", () => {
    const xml = `<rss version="2.0"><channel><item><title><![CDATA[CDATA な見出し & 記号]]></title><link>https://a/1</link></item></channel></rss>`;
    const items = parseNewsFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("CDATA な見出し & 記号");
  });
});
