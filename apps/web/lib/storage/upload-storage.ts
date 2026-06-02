import { Storage } from "@google-cloud/storage";

/**
 * F01 (#509 S2b): 教員アップロードファイルの **Cloud Storage 保存ポート**。
 *
 * `apps/jobs/src/reports/storage.ts` の `ReportStoragePort` と同じ port/adapter 構成。
 * route はこの interface に依存し、テストはフェイク storage を注入して GCS / 認証なしで
 * 保存配線を検証する。実体は `@google-cloud/storage` の薄いラッパで、認証は Cloud Run の
 * Workload Identity (ADC) に委ね JSON キーは配布しない（ルール5）。バケット名は env 注入
 * （ハードコード禁止・ルール5）。
 *
 * ## per-school オブジェクト prefix（テナント分離・PR #516 Reviewer Medium）
 * GCS は PostgreSQL RLS を尊重しない。バケットは校横断の単一バケットなので、保存キーを
 * **`uploads/{schoolId}/...` の per-school prefix** に必ず収め、将来 IAM condition で prefix 単位の
 * アクセス境界を張れるようにする（cross-tenant な object 読取を構造的に防ぐ土台）。保存キーの
 * 末尾は **サーバ生成 UUID + MIME 由来拡張子**で、クライアントのファイル名は path に使わない
 * （path traversal 防止、NFR03）。
 */

/** アップロードファイルを保存先へ書き込む最小ポート（実体は GCS、テストはフェイク）。 */
export interface UploadStoragePort {
  /**
   * 1 ファイルを保存する。
   * @param objectPath バケット内 object path（`buildUploadObjectPath` で生成、per-school prefix）。
   * @param body ファイルのバイト列。
   * @param contentType 保存時の Content-Type（検証済み MIME）。
   */
  save(objectPath: string, body: Buffer, contentType: string): Promise<void>;
}

/**
 * 保存先 object path を組み立てる。`uploads/{schoolId}/{objectId}.{ext}`。
 *
 * - **per-school prefix**: schoolId を path の第1階層に置く（テナント分離の prefix 境界）。
 * - **objectId はサーバ生成 UUID**、**ext は検証済み MIME 由来**（クライアントのファイル名を使わない）。
 *
 * @throws RangeError schoolId / objectId / ext が空、または schoolId/objectId に区切り文字 `/` を含むとき
 *   （prefix 境界を跨ぐ path injection を防ぐ）。
 */
export function buildUploadObjectPath(schoolId: string, objectId: string, ext: string): string {
  if (!schoolId || schoolId.includes("/")) {
    throw new RangeError("buildUploadObjectPath: schoolId が不正");
  }
  if (!objectId || objectId.includes("/")) {
    throw new RangeError("buildUploadObjectPath: objectId が不正");
  }
  if (!ext || ext.includes("/") || ext.includes(".")) {
    throw new RangeError("buildUploadObjectPath: ext が不正");
  }
  return `uploads/${schoolId}/${objectId}.${ext}`;
}

/** `createGcsUploadStorage` の設定。 */
export type GcsUploadStorageConfig = {
  /** 保存先バケット名（env `UPLOAD_BUCKET` 由来、ハードコード禁止・ルール5）。 */
  bucket: string;
  /** 注入用 `@google-cloud/storage` クライアント（テスト/モック用）。未指定なら ADC で生成。 */
  storage?: Storage;
};

/**
 * `@google-cloud/storage` を使う `UploadStoragePort` の実装。
 * 同一 path は上書き（保存キーは UUID なので実質衝突しない）。バケット名は env 注入、認証は ADC。
 */
export function createGcsUploadStorage(config: GcsUploadStorageConfig): UploadStoragePort {
  if (!config.bucket) {
    throw new Error(
      "createGcsUploadStorage: bucket が空です (env UPLOAD_BUCKET を設定してください)",
    );
  }
  const storage = config.storage ?? new Storage();
  const bucket = storage.bucket(config.bucket);
  return {
    async save(objectPath, body, contentType) {
      await bucket.file(objectPath).save(body, { contentType, resumable: false });
    },
  };
}

let cached: UploadStoragePort | null = null;

/**
 * プロセス共有の既定アップロードポート。env `UPLOAD_BUCKET` からバケット名を取得する。
 * バケット未設定（env 欠落）なら呼び出し時に明示エラー（フェイルクローズ）。route から使う。
 */
export function getUploadStorage(): UploadStoragePort {
  if (!cached) {
    cached = createGcsUploadStorage({ bucket: process.env.UPLOAD_BUCKET ?? "" });
  }
  return cached;
}
