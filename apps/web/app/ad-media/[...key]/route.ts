import { getAdMediaDownloadPort } from "@/lib/ads/media-download-port";
import { isValidAdMediaKey } from "@/lib/ads/media-object";
import { NextResponse } from "next/server";

/**
 * サイネージ広告メディアの **公開・同一オリジン配信 Route**（#46 / ADR-037、ADR-008 Route Handlers）。
 *
 * `GET /ad-media/<key>` — 公開 ad-media バケットのオブジェクト（`ads/...`）を、`app.school-signage.net`
 * 配下から **無認証で stream** する。サイネージ実機は県教委 Wi-Fi の FQDN 許可リスト上この 1 ドメインからのみ
 * 到達でき（prod main.tf / docs/discovery/wifi-filter-method.md）、`storage.googleapis.com` 直 URL は遮断され
 * うる。広告は **公開掲示物（企業の認知広告・PII 無し）** ゆえ無認証配信が安全側（reports の認証付き DL とは
 * 正反対のポリシー）。
 *
 * ## セキュリティ
 * - **任意オブジェクトの汎用プロキシ化を防ぐ**: `isValidAdMediaKey` で接頭辞 `ads/` + 安全文字 + `..` 不可を
 *   強制してから fetch する（path traversal / 接頭辞外参照を構造的に拒否）。バケット名は env のみ（外部 URL を
 *   一切受けない＝SSRF 面が無い）。
 * - **キャッシュ**: 保存キーはサーバ生成 UUID で内容不変ゆえ `public, max-age=1年, immutable`。公開掲示物で
 *   共有キャッシュ可（reports の `no-store` と対）。
 */

export const runtime = "nodejs";

/** 長期・不変キャッシュ（保存キーは UUID で内容不変・公開掲示物）。 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<NextResponse | Response> {
  const { key } = await context.params;
  // catch-all セグメント配列を 1 本の object key に連結してから検証する。
  const objectKey = Array.isArray(key) ? key.join("/") : "";
  if (!isValidAdMediaKey(objectKey)) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }

  const download = await getAdMediaDownloadPort().fetch(objectKey);
  if (!download) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const headers = new Headers({
    "Content-Type": download.contentType,
    "Cache-Control": CACHE_CONTROL,
  });
  if (download.contentLength !== undefined) {
    headers.set("Content-Length", String(download.contentLength));
  }
  return new Response(download.body, { status: 200, headers });
}
