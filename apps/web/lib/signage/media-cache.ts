import type { EffectiveAd } from "@kimiterrace/db";

/**
 * 公開サイネージ (#48-E / `/signage/{classToken}`) の広告画像・動画を **Service Worker +
 * Cache Storage** で先読み (prefetch) しておくモジュール (#48-G / F12, ADR-022)。
 *
 * V1 `management/src/lib/image-cache.ts` の IndexedDB blob キャッシュを置換する。V1 は
 * blob を IndexedDB に貯めて `URL.createObjectURL` で差し替えていたが、本実装は同一 URL の
 * GET を Service Worker (`public/sw.js`) が cache-first で透過処理するため、`<img>/<video>`
 * の `src` を書き換える必要がない (last-good 表示を素直に維持できる)。
 *
 * ## キャッシュ範囲とテナント分離 (CLAUDE.md ルール2/4/5)
 *
 * SW がキャッシュするのは **same-origin かつ `destination==='image'||'video'` の GET だけ**
 * (sw.js 側で `shouldCacheRequest` ガード、#201/閉域原則)。HTML / `/signage/{token}/data` の
 * token スコープ JSON / API、および cross-origin の外部 media は一切 intercept しないので、
 * no-store の即時失効とテナント分離 (RLS) が壊れない。media URL は公開アセットで PII/secret を
 * 含まず、credential (classToken) もここでは扱わない。
 *
 * ## 純粋関数 (テスト対象) とランタイム関数 (環境依存) の分離
 *
 * `selectPrefetchUrls` / `staleCacheKeys` は DOM/Cache 非依存の純粋関数 (unit テスト対象)。
 * `registerSignageServiceWorker` / `prefetchMedia` / `cleanupStaleMedia` は `caches` /
 * `navigator.serviceWorker` 不在時 (SSR・非対応ブラウザ・非セキュアコンテキスト) に全 no-op。
 */

/** SW と共有する版付きキャッシュ名 (sw.js の CACHE_NAME と一致させること)。 */
export const MEDIA_CACHE_NAME = "signage-media-v1";

/**
 * SW が intercept (cache-first) してよいリクエストか判定する **唯一の真実**。
 * 次の 3 条件すべてを満たす時だけ true:
 *   1. `GET` (副作用のない取得のみ)
 *   2. `destination` が `image` / `video` (= サイネージ広告 media)
 *   3. **same-origin** (リクエスト URL のオリジンが SW 自身のオリジン `selfOrigin` と一致)
 *
 * `public/sw.js` の `shouldCacheRequest` は本関数と **同一ロジックを複製**している (SW は静的
 * 配信の plain JS で TS lib を import できないため)。どちらかを変えたら必ず両方を揃え、この
 * 関数の unit テストで戦略を固定する。
 *
 * ## なぜ same-origin に限定するか (#201 / 閉域原則)
 *
 * cross-origin (外部 CDN) の media を SW が no-cors で取得すると **opaque レスポンス**
 * (`response.ok===false`) になり cache に貯まらない=瞬断耐性が効かないうえ、opaque は中身・
 * サイズが不可視で Cache Storage を不透明に圧迫する。本プロジェクトの閉域原則
 * ([[closed-system-security]] / 端末は外部を直叩きしない、ADR-021 JMA 取り込みと同型) では
 * サイネージ広告 media は **自校オリジン (GCS/Cloud Run 経由) で再配信**する前提なので、SW が
 * キャッシュすべきは same-origin media のみ。cross-origin はそもそも到達しない想定だが、仮に
 * 紛れ込んでも intercept せず素通りさせ (online ならブラウザが直接取得)、SW の respondWith 面
 * = セキュリティ境界を最小に保つ。cross-origin の真のオフライン対応が要ればバックエンド取り込み
 * Job で same-origin 再配信する (本 MVP ではスコープ外、#201)。
 *
 * これにより HTML / `/signage/{token}/data` の token スコープ JSON / API (document/script/
 * style/empty=XHR/navigation) も同様に SW が触らず、no-store の即時失効とテナント分離 (RLS)
 * を保全する。
 *
 * @param req         判定対象リクエスト (method / destination / url)。
 * @param selfOrigin  SW 自身のオリジン (`self.location.origin`)。same-origin 判定の基準。
 */
export function shouldCacheRequest(
  req: { method: string; destination: string; url: string },
  selfOrigin: string,
): boolean {
  if (req.method !== "GET") {
    return false;
  }
  if (req.destination !== "image" && req.destination !== "video") {
    return false;
  }
  return isSameOriginUrl(req.url, selfOrigin);
}

/**
 * `url` が `selfOrigin` と same-origin か。相対 URL は `selfOrigin` を基準に解決するため
 * same-origin と判定する。パースできない URL は false (= intercept しない、安全側)。
 */
function isSameOriginUrl(url: string, selfOrigin: string): boolean {
  try {
    return new URL(url, selfOrigin).origin === selfOrigin;
  } catch {
    return false;
  }
}

/**
 * 広告配列から prefetch すべき media URL を抽出する。falsy 除外 + 重複排除 (出現順を保つ)。
 * 入力順を保つことで「先に表示される広告から温める」挙動になる。
 */
export function selectPrefetchUrls(ads: readonly EffectiveAd[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const ad of ads) {
    const url = ad.mediaUrl;
    if (typeof url === "string" && url.length > 0 && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/**
 * cleanup 対象 (= キャッシュ済だが現行 ads に無い URL) を集合差分で求める。
 * クエリ文字列等の差異をそのまま尊重するため、URL 文字列の厳密一致で判定する。
 */
export function staleCacheKeys(
  cachedUrls: readonly string[],
  currentUrls: readonly string[],
): string[] {
  const current = new Set(currentUrls);
  return cachedUrls.filter((url) => !current.has(url));
}

/** Cache Storage が使えるか (SSR・非対応・非セキュアコンテキストで false)。 */
function hasCacheStorage(): boolean {
  return typeof caches !== "undefined";
}

/**
 * サイネージ用 Service Worker を登録する。feature 検出 + 非セキュアコンテキスト除外。
 * 例外は握りつぶす (登録失敗は last-good 表示に影響させない)。
 */
export async function registerSignageServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  // HTTPS か localhost のみ (SW はセキュアコンテキスト必須)。`isSecureContext` で一括判定。
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return;
  }
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // 登録失敗 (未対応・ネット断・スコープ衝突等) は無視。SW 無しでも表示は成立する。
  }
}

/**
 * 指定 URL 群をベストエフォートで Cache Storage に先読みする。個々の取得失敗は無視
 * (一部の広告が落ちても他を温める)。`caches` 不在時は no-op。
 */
export async function prefetchMedia(urls: readonly string[]): Promise<void> {
  if (!hasCacheStorage() || urls.length === 0) {
    return;
  }
  try {
    const cache = await caches.open(MEDIA_CACHE_NAME);
    await Promise.all(
      urls.map(async (url) => {
        try {
          // 既にあれば再取得しない (帯域節約)。SW 経由のヒットと整合。
          const hit = await cache.match(url);
          if (hit) {
            return;
          }
          await cache.add(url);
        } catch {
          // 個別 URL の取得失敗は無視。
        }
      }),
    );
  } catch {
    // cache オープン自体の失敗も無視。
  }
}

/**
 * 現行 ads に無い media を Cache Storage から削除する (際限ないキャッシュ肥大を防ぐ)。
 * `caches` 不在時は no-op。削除失敗は無視。
 */
export async function cleanupStaleMedia(currentUrls: readonly string[]): Promise<void> {
  if (!hasCacheStorage()) {
    return;
  }
  try {
    const cache = await caches.open(MEDIA_CACHE_NAME);
    const requests = await cache.keys();
    const cachedUrls = requests.map((req) => req.url);
    const stale = new Set(staleCacheKeys(cachedUrls, currentUrls));
    await Promise.all(
      requests
        .filter((req) => stale.has(req.url))
        .map(async (req) => {
          try {
            await cache.delete(req);
          } catch {
            // 個別削除の失敗は無視。
          }
        }),
    );
  } catch {
    // cache オープン自体の失敗も無視。
  }
}
