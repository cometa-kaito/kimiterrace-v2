/*
 * サイネージ用 Service Worker (#48-G / F12, ADR-022)。
 * `/signage/{classToken}` の広告画像・動画だけを cache-first で透過キャッシュし、学校 Wi-Fi の
 * 瞬断に対するオフライン耐性を上げる。V1 `management/src/lib/image-cache.ts` (IndexedDB blob)
 * の置換。plain JS (静的配信、`/sw.js`)。
 *
 * ## 最重要: media 以外は一切 intercept しない
 * `fetch` ハンドラは `shouldCacheRequest` が true のリクエスト (GET かつ image/video) でのみ
 * `respondWith` する。HTML / `/signage/{token}/data` の token スコープ JSON / API
 * (document/script/style/empty=XHR/navigation 等) は素通りさせるので、ブラウザ既定の no-store が
 * 効き続け、**即時失効とテナント分離 (RLS, CLAUDE.md ルール2) が壊れない**。media URL は公開
 * アセットで PII/secret を含まない (ルール4/5)。token・credential はログに出さない。
 *
 * `shouldCacheRequest` のロジックは `apps/web/lib/signage/media-cache.ts` の同名関数と同一
 * (そちらが unit テストで戦略を固定する真実のソース)。変更時は両方を揃えること。
 */

/// <reference lib="webworker" />

// 版付きキャッシュ名 (media-cache.ts の MEDIA_CACHE_NAME と一致させること)。
const CACHE_NAME = "signage-media-v1";

/**
 * intercept (cache-first) してよいリクエストか。GET かつ画像/動画のみ。
 * @param {{ method: string, destination: string }} req
 * @returns {boolean}
 */
function shouldCacheRequest(req) {
  return req.method === "GET" && (req.destination === "image" || req.destination === "video");
}

self.addEventListener("install", () => {
  // 新 SW を即時有効化 (古い media SW を待たない)。
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // 現行 CACHE_NAME 以外の旧版 media キャッシュを掃除し、即座に制御を奪う。
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("signage-media-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // media (image/video) の GET 以外は respondWith せず素通り (no-store / RLS 保全)。
  if (!shouldCacheRequest(request)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // cache-first: ヒットすれば即返す (瞬断中でも last-good media を表示)。
      const cached = await cache.match(request);
      if (cached) {
        return cached;
      }
      // ミス: network → 成功時のみ cache.put。失敗かつ cache 無しはそのまま失敗を返す。
      const response = await fetch(request);
      if (response?.ok) {
        // Response は 1 度しか読めないので clone を保存。
        cache.put(request, response.clone()).catch(() => {
          // 容量超過等の put 失敗は無視 (表示優先)。
        });
      }
      return response;
    })(),
  );
});
