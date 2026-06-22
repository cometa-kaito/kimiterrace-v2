import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getLatestNews, saveNewsItems } from "../../src/queries/news-items.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * pattern2/3「工学ニュース」 news_items の RLS（公開参照マスタ特例：read_all + write_system）を実 PG で検証する。
 * weather_forecasts（0017）/ railway_status（0025）と同型。匿名サイネージが読め、system_admin（取得 Job）
 * だけが書ける。
 */
describeOrSkip("RLS: news_items（工学ニュース見出し・公開キャッシュ）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxSys = () => ({ role: "system_admin" as const });
  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
  // 匿名サイネージ: role 未設定・school_id のみ（ADR-016 の deny-by-default 接続）。
  const ctxAnon = () => ({ schoolId: fx.schoolA });

  const item = (title: string, url: string, publishedAt?: Date, summary?: string | null) =>
    ({
      source: "jst" as const,
      sourceLabel: "JST サイエンスポータル",
      title,
      url,
      summary: summary ?? null,
      publishedAt: publishedAt ?? null,
    }) as const;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM news_items`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("system は upsert でき、匿名サイネージ / school_admin とも read できる（read_all）", async () => {
    await withTenantContext(
      db,
      ctxSys(),
      (tx) =>
        saveNewsItems(tx, [
          item(
            "H3ロケット、新型エンジンの燃焼試験に成功",
            "https://scienceportal.jst.go.jp/a/",
            new Date("2026-06-18T00:00:00Z"),
          ),
          item(
            "グラフェンの新しい加工技術を開発",
            "https://scienceportal.jst.go.jp/b/",
            new Date("2026-06-17T00:00:00Z"),
          ),
        ]),
      APP,
    );

    const anon = await withTenantContext(db, ctxAnon(), (tx) => getLatestNews(tx, 8), APP);
    expect(anon).toHaveLength(2);
    // 公開日降順 → 最新が先頭。
    expect(anon[0]?.title).toBe("H3ロケット、新型エンジンの燃焼試験に成功");
    expect(anon[0]?.sourceLabel).toBe("JST サイエンスポータル");

    const a = await withTenantContext(db, ctxA(), (tx) => getLatestNews(tx, 8), APP);
    expect(a).toHaveLength(2);
  });

  it("upsert は同一 (source,url) を 1 行で更新する（ON CONFLICT (source, url)）", async () => {
    await withTenantContext(
      db,
      ctxSys(),
      (tx) => saveNewsItems(tx, [item("旧見出し", "https://scienceportal.jst.go.jp/x/")]),
      APP,
    );
    await withTenantContext(
      db,
      ctxSys(),
      (tx) => saveNewsItems(tx, [item("差し替え後の見出し", "https://scienceportal.jst.go.jp/x/")]),
      APP,
    );

    const r = await withTenantContext(db, ctxAnon(), (tx) => getLatestNews(tx, 8), APP);
    expect(r).toHaveLength(1);
    expect(r[0]?.title).toBe("差し替え後の見出し");
    const [{ count }] = await raw<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM news_items`;
    expect(count).toBe(1);
  });

  it("非 system（school_admin）コンテキストは書き込めない（write_system）", async () => {
    await expect(
      withTenantContext(
        db,
        ctxA(),
        (tx) => saveNewsItems(tx, [item("不正書込", "https://scienceportal.jst.go.jp/z/")]),
        APP,
      ),
    ).rejects.toThrow();
  });

  it("該当が無ければ空配列（fail-soft）", async () => {
    const r = await withTenantContext(db, ctxAnon(), (tx) => getLatestNews(tx, 8), APP);
    expect(r).toEqual([]);
  });

  it("summary を保持・更新する（CC BY 要約の upsert・ADR-043 §2026-06-20）", async () => {
    // 初回: 要約付きで保存（実運用では meti などの CC BY ソース。本テストは列の往復のみ検証）。
    await withTenantContext(
      db,
      ctxSys(),
      (tx) =>
        saveNewsItems(tx, [
          item("要約付き記事", "https://example.go.jp/press/1", undefined, "一文目。二文目。"),
        ]),
      APP,
    );
    let r = await withTenantContext(db, ctxAnon(), (tx) => getLatestNews(tx, 8), APP);
    expect(r[0]?.summary).toBe("一文目。二文目。");

    // 再取得（upsert）で summary を差し替える（excluded.summary）。null 化も反映されること。
    await withTenantContext(
      db,
      ctxSys(),
      (tx) =>
        saveNewsItems(tx, [item("要約付き記事", "https://example.go.jp/press/1", undefined, null)]),
      APP,
    );
    r = await withTenantContext(db, ctxAnon(), (tx) => getLatestNews(tx, 8), APP);
    expect(r).toHaveLength(1);
    expect(r[0]?.summary).toBeNull();
  });

  it("要約付き（CC BY=METI 等）を、公開日が古くても見出しのみ項目より上位に並べる（METI 中心・2026-06-20）", async () => {
    // 見出しのみ（要約なし・文科省等）が直近大量公開で要約付き METI を押し出す事象を防ぐため、要約付きを上位固定。
    await withTenantContext(
      db,
      ctxSys(),
      (tx) =>
        saveNewsItems(tx, [
          // 見出しのみ（要約なし）だが公開日が新しい（押し出し側）。
          item("見出しのみ新", "https://www.mext.go.jp/n1", new Date("2026-06-20T00:00:00Z"), null),
          item(
            "見出しのみ新2",
            "https://www.mext.go.jp/n2",
            new Date("2026-06-19T00:00:00Z"),
            null,
          ),
          // 要約付き（METI 相当）だが公開日が古い（本来は下に沈むが、要約優先で先頭へ来るべき）。
          item(
            "要約付き古",
            "https://www.meti.go.jp/m1",
            new Date("2026-06-15T00:00:00Z"),
            "経産省の公式要約。二文目。",
          ),
        ]),
      APP,
    );
    const r = await withTenantContext(db, ctxAnon(), (tx) => getLatestNews(tx, 8), APP);
    expect(r).toHaveLength(3);
    // ① 要約付きが、より新しい見出しのみ項目より先頭に来る。
    expect(r[0]?.title).toBe("要約付き古");
    expect(r[0]?.summary).toBe("経産省の公式要約。二文目。");
    // ② 見出しのみは後段で公開日降順。
    expect(r[1]?.title).toBe("見出しのみ新");
    expect(r[2]?.title).toBe("見出しのみ新2");
  });
});
