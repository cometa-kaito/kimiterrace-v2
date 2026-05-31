/*
 * サイネージ用 Service Worker (#48-G / F12, ADR-022)。
 * `/signage/{classToken}` の **same-origin** な広告画像・動画だけを cache-first で透過キャッシュし、
 * 学校 Wi-Fi の瞬断に対するオフライン耐性を上げる。V1 `management/src/lib/image-cache.ts`
 * (IndexedDB blob) の置換。plain JS (静的配信、`/sw.js`)。
 *
 * ## 最重要: same-origin の media 以外は一切 intercept しない
 * `fetch` ハンドラは `shouldCacheRequest` が true のリクエスト (GET かつ image/video かつ
 * same-origin) でのみ `respondWith` する。HTML / `/signage/{token}/data` の token スコープ
 * JSON / API (document/script/style/empty=XHR/navigation 等)、および cross-origin の外部 media は
 * 素通りさせるので、ブラウザ既定の no-store が効き続け、**即時失効とテナント分離 (RLS,
 * CLAUDE.md ルール2) が壊れない**。media URL は公開アセットで PII/secret を含まない (ルール4/5)。
 * token・credential はログに出さない。
 *
 * ## cross-origin を caching しない理由 (#201 / 閉域原則)
 * 外部 CDN の media を no-cors で取ると opaque (`response.ok===false`) で cache に貯まらず瞬断
 * 耐性も効かない。閉域原則 (端末は外部直叩きしない、ADR-021 と同型) では広告 media は自校
 * オリジンで再配信する前提なので same-origin のみキャッシュ対象とし、respondWith 面 (=
 * セキュリティ境界) を最小に保つ。cross-origin の真のオフライン対応はバックエンド取り込み再配信
 * に委ねる (本 MVP ではスコープ外)。
 *
 * `shouldCacheRequest` のロジックは `apps/web/lib/signage/media-cache.ts` の同名関数と同一
 * (そちらが unit テストで戦略を固定する真実のソース)。変更時は両方を揃えること。
 */

/// <reference lib="webworker" />

// 版付きキャッシュ名 (media-cache.ts の MEDIA_CACHE_NAME と一致させること)。
const CACHE_NAME = "signage-media-v1";

/**
 * intercept (cache-first) してよいリクエストか。GET かつ画像/動画かつ same-origin のみ。
 *
 * ⚠️ セキュリティ境界: この述語が false のものは fetch ハンドラで素通りする (キャッシュしない)。
 * この「same-origin の media 以外は素通り」がオリジン全体 (SW 制御スコープは `/`、/admin 含む)
 * の安全性を担保している。**条件を広げると HTML / token スコープ JSON / API までキャッシュし得て、
 * 即時失効・テナント分離 (RLS) が壊れる**。広げる場合は必ず影響を再評価すること。
 *
 * `apps/web/lib/signage/media-cache.ts` の同名関数と同一ロジック (そちらが unit テストで戦略を
 * 固定する真実のソース)。same-origin 限定の理由はファイル冒頭コメント参照 (#201 / 閉域原則)。
 * @param {{ method: string, destination: string, url: string }} req
 * @param {string} selfOrigin SW 自身のオリジン (`self.location.origin`)
 * @returns {boolean}
 */
function shouldCacheRequest(req, selfOrigin) {
  if (req.method !== "GET") {
    return false;
  }
  if (req.destination !== "image" && req.destination !== "video") {
    return false;
  }
  return isSameOriginUrl(req.url, selfOrigin);
}

/**
 * `url` が `selfOrigin` と same-origin か。相対 URL は `selfOrigin` 基準で解決するため same-origin。
 * パースできない URL は false (= intercept しない、安全側)。media-cache.ts の同名関数と同一。
 * @param {string} url
 * @param {string} selfOrigin
 * @returns {boolean}
 */
function isSameOriginUrl(url, selfOrigin) {
  try {
    return new URL(url, selfOrigin).origin === selfOrigin;
  } catch {
    return false;
  }
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

  // same-origin の media (image/video) GET 以外は respondWith せず素通り (no-store / RLS 保全)。
  if (!shouldCacheRequest(request, self.location.origin)) {
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
