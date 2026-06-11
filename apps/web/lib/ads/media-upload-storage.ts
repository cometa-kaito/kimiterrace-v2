import { type UploadStoragePort, createGcsUploadStorage } from "../storage/upload-storage";

/**
 * #46 / ADR-037: 広告メディアの **公開バケット書き込みポート** のプロセス内シングルトン解決。
 *
 * 実体は汎用 GCS 保存アダプタ `createGcsUploadStorage`（`save(objectKey, body, contentType)`）を
 * **ad-media バケット**に向けたもの。教員アップロード（per-school・非公開 `UPLOAD_BUCKET`）とは別バケットで、
 * こちらは **公開掲示物用の ad-media バケット**（`AD_MEDIA_BUCKET`・allUsers:read）。認証は Workload Identity
 * （ADC）、バケット名は env 注入（ハードコード禁止・ルール5）。配信は同一オリジン Route（ADR-037）。
 */

/** 書き込み先バケット名（env）。未設定はサーバー設定不備として throw（ルール5）。 */
function resolveAdMediaBucket(): string {
  const bucket = process.env.AD_MEDIA_BUCKET;
  if (!bucket) {
    throw new Error(
      "AD_MEDIA_BUCKET is not set. 広告メディア配信バケット名を env で注入する (Terraform ad_media モジュール / CLAUDE.md ルール5)。",
    );
  }
  return bucket;
}

let cached: UploadStoragePort | null = null;

/** プロセス内で使い回す ad-media 書き込みポートを返す（GCS クライアントの再生成を避ける）。 */
export function getAdMediaUploadStorage(): UploadStoragePort {
  if (!cached) {
    cached = createGcsUploadStorage({ bucket: resolveAdMediaBucket() });
  }
  return cached;
}

/** テスト用: プロセスキャッシュをリセットする。 */
export function resetAdMediaUploadStorageForTest(): void {
  cached = null;
}
