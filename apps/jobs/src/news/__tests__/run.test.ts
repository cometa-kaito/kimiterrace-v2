import { describe, expect, it, vi } from "vitest";
import type { ParsedNewsItem } from "../news-parse.js";
import { type NewsFeed, parseFeedsEnv, runNewsFetch } from "../run.js";

/**
 * 工学ニュース取得バッチのオーケストレーション（ADR-043）を、fetch/DB を注入して検証する。フィード単位の
 * fail-soft（1 フィード失敗で他は継続・last-known-good 維持・例外を投げない）と、成功時に見出し + 出典のみを
 * upsert に渡すことを確認する（鉄道 railway-status/run.test 相当）。
 */

const FEED_JST: NewsFeed = {
  source: "jst",
  sourceLabel: "JST サイエンスポータル",
  url: "https://scienceportal.jst.go.jp/feed/rss.xml",
};
const FEED_MEXT: NewsFeed = {
  source: "mext",
  sourceLabel: "文部科学省",
  url: "https://www.mext.go.jp/b_menu/news/index.rdf",
};

const ITEM_A: ParsedNewsItem = {
  title: "記事A",
  url: "https://a/1",
  publishedAt: new Date("2026-06-01T00:00:00Z"),
};
const ITEM_B: ParsedNewsItem = { title: "記事B", url: "https://a/2", publishedAt: null };
const jstItems: ParsedNewsItem[] = [ITEM_A, ITEM_B];

describe("runNewsFetch", () => {
  it("全フィード成功: 各フィードを saveItems に渡し集計を返す", async () => {
    const saveItems = vi.fn(async (items: readonly unknown[]) => items.length);
    const summary = await runNewsFetch({
      listFeeds: () => [FEED_JST, FEED_MEXT],
      fetchFeed: async (feed) => (feed.source === "jst" ? jstItems : [ITEM_A]),
      saveItems,
    });

    expect(saveItems).toHaveBeenCalledTimes(2);
    // 見出し + 出典のみが渡る（source/sourceLabel はフィード定義から付与・本文は無い）。
    expect(saveItems.mock.calls[0]?.[0]).toEqual([
      {
        source: "jst",
        sourceLabel: "JST サイエンスポータル",
        title: "記事A",
        url: "https://a/1",
        publishedAt: new Date("2026-06-01T00:00:00Z"),
      },
      {
        source: "jst",
        sourceLabel: "JST サイエンスポータル",
        title: "記事B",
        url: "https://a/2",
        publishedAt: null,
      },
    ]);
    expect(summary).toEqual({
      feeds: 2,
      fetchedFeeds: 2,
      rowsUpserted: 3,
      failed: 0,
      failedFeeds: [],
    });
  });

  it("1 フィード取得失敗: そのフィードのみ skip・他は継続（fail-soft）", async () => {
    const saveItems = vi.fn(async (items: readonly unknown[]) => items.length);
    const summary = await runNewsFetch({
      listFeeds: () => [FEED_JST, FEED_MEXT],
      fetchFeed: async (feed) => {
        if (feed.source === "mext") {
          throw new Error("network");
        }
        return jstItems;
      },
      saveItems,
    });

    // jst の 1 回だけ保存され、mext は failedFeeds に積まれる（既存キャッシュは触らない）。
    expect(saveItems).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({
      feeds: 2,
      fetchedFeeds: 1,
      rowsUpserted: 2,
      failed: 1,
      failedFeeds: ["mext"],
    });
  });

  it("保存失敗（saveItems が throw）もそのフィードのみ skip", async () => {
    const summary = await runNewsFetch({
      listFeeds: () => [FEED_JST],
      fetchFeed: async () => jstItems,
      saveItems: async () => {
        throw new Error("db");
      },
    });
    expect(summary).toEqual({
      feeds: 1,
      fetchedFeeds: 0,
      rowsUpserted: 0,
      failed: 1,
      failedFeeds: ["jst"],
    });
  });

  it("全フィード失敗: 例外を投げず failed=feeds・fetchedFeeds=0 を返す（entrypoint が非ゼロ終了を判断）", async () => {
    const summary = await runNewsFetch({
      listFeeds: () => [FEED_JST, FEED_MEXT],
      fetchFeed: async () => {
        throw new Error("all down");
      },
      saveItems: async () => 0,
    });
    expect(summary.feeds).toBe(2);
    expect(summary.fetchedFeeds).toBe(0);
    expect(summary.failed).toBe(2);
    expect(summary.failedFeeds).toEqual(["jst", "mext"]);
  });

  it("空フィード取得（0 件）でも成功扱い（upsert は 0 行）", async () => {
    const saveItems = vi.fn(async () => 0);
    const summary = await runNewsFetch({
      listFeeds: () => [FEED_JST],
      fetchFeed: async () => [],
      saveItems,
    });
    expect(saveItems).toHaveBeenCalledWith([]);
    expect(summary).toEqual({
      feeds: 1,
      fetchedFeeds: 1,
      rowsUpserted: 0,
      failed: 0,
      failedFeeds: [],
    });
  });
});

describe("parseFeedsEnv", () => {
  it("未設定 / 空文字は null（呼び出し側が DEFAULT_NEWS_FEEDS に倒す）", () => {
    expect(parseFeedsEnv(undefined)).toBeNull();
    expect(parseFeedsEnv("")).toBeNull();
    expect(parseFeedsEnv("   ")).toBeNull();
  });

  it("正常な JSON 配列を NewsFeed[] にする（meti を env 追加できる）", () => {
    const raw = JSON.stringify([
      { source: "jst", sourceLabel: "JST", url: "https://a/rss" },
      { source: "meti", sourceLabel: "経済産業省", url: "https://meti/rss" },
    ]);
    expect(parseFeedsEnv(raw)).toEqual([
      { source: "jst", sourceLabel: "JST", url: "https://a/rss" },
      { source: "meti", sourceLabel: "経済産業省", url: "https://meti/rss" },
    ]);
  });

  it("不正 JSON は null（壊れ env で全断しない）", () => {
    expect(parseFeedsEnv("{not json")).toBeNull();
  });

  it("配列でない JSON は null", () => {
    expect(parseFeedsEnv(JSON.stringify({ source: "jst" }))).toBeNull();
  });

  it("enum 外の source / 欠落フィールドの要素は捨て、有効分だけ返す", () => {
    const raw = JSON.stringify([
      { source: "yahoo", sourceLabel: "Yahoo", url: "https://y/rss" }, // enum 外 → 捨てる
      { source: "jst", url: "https://a/rss" }, // sourceLabel 欠落 → 捨てる
      { source: "mext", sourceLabel: "文科省", url: "https://m/rss" }, // 有効
    ]);
    expect(parseFeedsEnv(raw)).toEqual([
      { source: "mext", sourceLabel: "文科省", url: "https://m/rss" },
    ]);
  });

  it("全要素が不正なら null（誤設定で 0 フィードにしない）", () => {
    const raw = JSON.stringify([{ source: "bad" }, { url: "https://x" }]);
    expect(parseFeedsEnv(raw)).toBeNull();
  });
});
