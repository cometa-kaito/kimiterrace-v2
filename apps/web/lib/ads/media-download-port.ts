import { type AdMediaDownloadPort, createGcsAdMediaDownload } from "./media-download";

/**
 * 広告メディア配信ポート（`AdMediaDownloadPort`）のプロセス内シングルトン解決（#46 / ADR-037）。
 *
 * バケット名は env `AD_MEDIA_BUCKET` から解決する（ハードコード禁止・ルール5。Terraform `ad_media`
 * モジュールのバケット名を Cloud Run env に注入）。認証は Workload Identity（ADC、JSON キー不使用・ルール5）。
 * 配信 Route はこの解決器に依存し、テストでは `@/lib/ads/media-download-port` をモックして GCS / 認証なしで
 * 配線を検証する（reports の download-port と同じ DI 方針）。
 */

/**
 * 配信バケット名（env）。未設定はサーバー設定不備として throw（ルール5）。
 * 本番は Cloud Run env（Terraform 注入）、ローカル/テストは .env.local で設定する。
 */
function resolveAdMediaBucket(): string {
  const bucket = process.env.AD_MEDIA_BUCKET;
  if (!bucket) {
    throw new Error(
      "AD_MEDIA_BUCKET is not set. 広告メディア配信バケット名を env で注入する (Terraform ad_media モジュール / CLAUDE.md ルール5)。",
    );
  }
  return bucket;
}

let cached: AdMediaDownloadPort | null = null;

/** プロセス内で使い回す `AdMediaDownloadPort` を返す（GCS クライアントの再生成を避ける）。 */
export function getAdMediaDownloadPort(): AdMediaDownloadPort {
  if (cached) {
    return cached;
  }
  cached = createGcsAdMediaDownload({ bucket: resolveAdMediaBucket() });
  return cached;
}

/** テスト用: プロセスキャッシュをリセットする。 */
export function resetAdMediaDownloadPortForTest(): void {
  cached = null;
}
