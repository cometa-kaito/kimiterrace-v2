import { selectPrefetchUrls, shouldCacheRequest, staleCacheKeys } from "@/lib/signage/media-cache";
import type { EffectiveAd } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";

/**
 * #48-G サイネージ media prefetch の純粋ロジック。Cache Storage / SW 自体の挙動は vitest で
 * 検証困難なため、(a) prefetch URL の抽出・dedup、(b) cleanup の集合差分、(c) SW が intercept
 * してよいリクエストの判定 (= media 以外を触らない保証) の 3 点を固定する。
 */

/**
 * mediaUrl だけ可変にした完全な EffectiveAd を組む (型は Drizzle 単一ソースを尊重、cast 無し)。
 * prefetch 抽出ロジックが見るのは mediaUrl のみなので他フィールドは固定のダミーで足りる。
 */
function ad(mediaUrl: string): EffectiveAd {
  return {
    classId: "00000000-0000-0000-0000-000000000001",
    adId: "00000000-0000-0000-0000-000000000002",
    schoolId: "00000000-0000-0000-0000-000000000003",
    sourceScope: "class",
    scopeRank: 3,
    isInherited: false,
    mediaUrl,
    mediaType: "image",
    durationSec: 5,
    linkUrl: null,
    caption: null,
    captionFontScale: 1,
    displayOrder: 0,
  };
}

describe("selectPrefetchUrls", () => {
  it("mediaUrl を出現順に抽出する", () => {
    expect(selectPrefetchUrls([ad("https://cdn/a.png"), ad("https://cdn/b.mp4")])).toEqual([
      "https://cdn/a.png",
      "https://cdn/b.mp4",
    ]);
  });

  it("重複 URL を除外する (最初の出現を保つ)", () => {
    expect(
      selectPrefetchUrls([
        ad("https://cdn/a.png"),
        ad("https://cdn/a.png"),
        ad("https://cdn/b.png"),
      ]),
    ).toEqual(["https://cdn/a.png", "https://cdn/b.png"]);
  });

  it("空・falsy な mediaUrl を除外する", () => {
    expect(selectPrefetchUrls([ad(""), ad("https://cdn/a.png")])).toEqual(["https://cdn/a.png"]);
  });

  it("空配列は空を返す", () => {
    expect(selectPrefetchUrls([])).toEqual([]);
  });
});

describe("staleCacheKeys", () => {
  it("現行に無いキャッシュ URL だけを返す", () => {
    expect(
      staleCacheKeys(["https://cdn/old.png", "https://cdn/keep.png"], ["https://cdn/keep.png"]),
    ).toEqual(["https://cdn/old.png"]);
  });

  it("全て現行に含まれれば空", () => {
    expect(
      staleCacheKeys(["https://cdn/a.png"], ["https://cdn/a.png", "https://cdn/b.png"]),
    ).toEqual([]);
  });

  it("キャッシュが空なら空", () => {
    expect(staleCacheKeys([], ["https://cdn/a.png"])).toEqual([]);
  });
});

describe("shouldCacheRequest (SW intercept ガード)", () => {
  // SW 自身のオリジン (same-origin 判定の基準)。テストでは固定の自校オリジンを用いる。
  const ORIGIN = "https://signage.example.test";
  /** リクエストもどきを組む小ヘルパ (real Request の url は常に絶対 URL)。 */
  const req = (method: string, destination: string, url: string) => ({ method, destination, url });

  it("same-origin の GET image / video は true", () => {
    expect(shouldCacheRequest(req("GET", "image", `${ORIGIN}/ads/a.png`), ORIGIN)).toBe(true);
    expect(shouldCacheRequest(req("GET", "video", `${ORIGIN}/ads/b.mp4`), ORIGIN)).toBe(true);
  });

  it("cross-origin の media は false (#201 / 閉域原則: opaque を貯めない・境界最小化)", () => {
    expect(shouldCacheRequest(req("GET", "image", "https://cdn.example.com/a.png"), ORIGIN)).toBe(
      false,
    );
    expect(shouldCacheRequest(req("GET", "video", "https://cdn.example.com/b.mp4"), ORIGIN)).toBe(
      false,
    );
    // 同一ホストでもポート違いは別オリジン → false。
    expect(
      shouldCacheRequest(req("GET", "image", "https://signage.example.test:8443/a.png"), ORIGIN),
    ).toBe(false);
  });

  it("相対 URL は selfOrigin 基準で same-origin と解決し true", () => {
    expect(shouldCacheRequest(req("GET", "image", "/ads/a.png"), ORIGIN)).toBe(true);
  });

  it("パースできない URL は false (安全側で intercept しない)", () => {
    expect(shouldCacheRequest(req("GET", "image", "http://"), ORIGIN)).toBe(false);
  });

  it("document / script / style / xhr (empty) / navigation は same-origin でも false (no-store・RLS 保全)", () => {
    for (const destination of ["document", "script", "style", "", "audio", "font"]) {
      expect(shouldCacheRequest(req("GET", destination, `${ORIGIN}/x`), ORIGIN)).toBe(false);
    }
  });

  it("非 GET (POST 等) は same-origin media でも false", () => {
    expect(shouldCacheRequest(req("POST", "image", `${ORIGIN}/a.png`), ORIGIN)).toBe(false);
    expect(shouldCacheRequest(req("HEAD", "video", `${ORIGIN}/b.mp4`), ORIGIN)).toBe(false);
  });
});
