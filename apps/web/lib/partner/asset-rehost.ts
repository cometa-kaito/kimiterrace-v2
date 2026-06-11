import { Storage } from "@google-cloud/storage";

/**
 * Partner API K3（`docs/api/partner-api-contract.md` §3）: portal が渡す **短命署名 URL**（`assetFetchUrl`、
 * Supabase 署名 URL・約 10 分有効）の広告クリエイティブを v2 が取得し、**公開 ad-media バケットへ再ホスト**して
 * 永続の配信 URL（`ads.media_url`）を返すポート。
 *
 * ## なぜ再ホストするか
 * `assetFetchUrl` は短命（10 分）なので、そのまま `media_url` に保存するとサイネージ端末が後で GET したとき
 * 失効している。サイネージは `ads.media_url` を `<img>`/`<video>` で**直接 GET** する（公開掲示物・PII 無し、
 * `infrastructure/terraform/modules/ad_media` の公開バケット）。よって取得 → 公開バケットへ保存 → その公開 URL を
 * 返す必要がある。広告は企業の認知広告であり生徒 PII を含まない（教員アップロード `UPLOAD_BUCKET` の per-school
 * 非公開素材とは正反対のポリシー、ad_media モジュール doc）。
 *
 * ## 【要件2】エラー方針（portal の再送判断: 4xx=fatal / 5xx=transient）
 * `assetFetchUrl` の取得失敗（署名 URL 期限切れ・ネットワーク断）と GCS アップロード失敗は **transient**
 * （再送で回復しうる）= route で **5xx**。`AssetRehostError` を投げ、route が 502/500 に写す。恒久不整合
 * （payload 不正等）はここに来る前に route のバリデーションで 4xx として弾く。
 *
 * ## 現状（GCS バケット未プロビジョニング・ルール8 = この PR で Terraform を足さない）
 * 公開 ad-media バケットは Terraform `modules/ad_media` で定義済みだが各 env で **enabled=false**（実体未生成）で、
 * このルートが使う env（`AD_MEDIA_BUCKET`）も未配線。したがって既定は **passthrough**:
 *   - `AD_MEDIA_BUCKET` 未設定なら **再ホストせず assetFetchUrl をそのまま** `media_url` として返す（暫定）。
 *     これにより受け口は今日から機能し、署名 URL の短命さは「短期検証用途では許容」する暫定運用とする。
 *   - バケットが配線されたら（Terraform で `ad_media` を enabled 化 + Cloud Run に `AD_MEDIA_BUCKET` を注入）、
 *     自動で取得 → 再ホスト経路に切り替わる（コード変更不要）。
 * **TODO（別 Issue・ルール8 Terraform 管轄）**: `modules/ad_media` を各 env で enabled 化し、Cloud Run service へ
 * `AD_MEDIA_BUCKET` を env 注入する。それまでは passthrough（要 GCS 再ホスト）。
 */

/** 取得 / アップロードの transient 失敗（要件2: route が 5xx に写す）。 */
export class AssetRehostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssetRehostError";
  }
}

/** 1 アセットを「取得 → 配信先へ再ホスト → 公開 URL を返す」ポート。 */
export interface AssetRehostPort {
  /**
   * @param fetchUrl  portal の短命署名 URL（取得元）。
   * @param objectId  保存先 object のキー（呼び出し側がサーバ生成、通常 portalPlacementId）。
   * @returns         サイネージが直接 GET する永続の公開 URL。
   * @throws AssetRehostError 取得失敗・アップロード失敗（transient）。
   */
  rehost(fetchUrl: string, objectId: string): Promise<string>;
}

/** 取得バイト数の実務上限（暴走入力防止）。広告クリエイティブは画像/短尺動画想定。 */
const MAX_ASSET_BYTES = 50 * 1024 * 1024; // 50 MiB

/** object キーに使えるのは UUID 様の安全文字のみ（path injection 防止）。 */
const SAFE_OBJECT_ID = /^[0-9a-zA-Z._-]+$/;

/**
 * passthrough 実装: 取得も再ホストもせず `fetchUrl` をそのまま返す（バケット未配線時の暫定、上記 doc）。
 * 署名 URL の失効リスクは暫定運用として許容。バケット配線後は `createGcsAssetRehost` に置き換わる。
 */
export function createPassthroughAssetRehost(): AssetRehostPort {
  return {
    async rehost(fetchUrl: string): Promise<string> {
      return fetchUrl;
    },
  };
}

/** `createGcsAssetRehost` の設定。 */
export type GcsAssetRehostConfig = {
  /** 公開 ad-media バケット名（env `AD_MEDIA_BUCKET` 由来、ハードコード禁止・ルール5）。 */
  bucket: string;
  /** 保存キーの prefix（既定 `partner`）。サイネージ広告の出所を分ける。 */
  prefix?: string;
  /** 注入用 `@google-cloud/storage` クライアント（テスト/モック用）。未指定なら ADC で生成。 */
  storage?: Storage;
  /** 取得に使う fetch（テスト注入用）。未指定なら global fetch。 */
  fetchImpl?: typeof fetch;
};

/**
 * `@google-cloud/storage` を使う再ホスト実装。`fetchUrl` を GET → 公開バケットへ保存 → 公開 URL を返す。
 * 認証は Cloud Run の Workload Identity（ADC）、JSON キーは配布しない（ルール5）。バケット名は env 注入。
 */
export function createGcsAssetRehost(config: GcsAssetRehostConfig): AssetRehostPort {
  if (!config.bucket) {
    throw new Error(
      "createGcsAssetRehost: bucket が空です (env AD_MEDIA_BUCKET を設定してください)",
    );
  }
  const storage = config.storage ?? new Storage();
  const bucket = storage.bucket(config.bucket);
  const prefix = config.prefix ?? "partner";
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async rehost(fetchUrl: string, objectId: string): Promise<string> {
      if (!SAFE_OBJECT_ID.test(objectId) || objectId.includes("..")) {
        // 呼出側のキー生成不正（恒久）。transient ではないが、route 到達前に portalPlacementId を UUID 検証
        // 済みのため通常到達しない。多層防御として明示エラー。
        throw new Error(`createGcsAssetRehost: 不正な objectId: ${objectId}`);
      }

      // 1. 取得（transient: 署名 URL 失効・ネットワーク断 → AssetRehostError → route 5xx）。
      let res: Response;
      try {
        res = await doFetch(fetchUrl);
      } catch (cause) {
        throw new AssetRehostError("asset fetch failed", { cause });
      }
      if (!res.ok) {
        // 4xx/5xx いずれもここでは transient 扱い（403=署名失効も再発行で回復しうる）。route が 5xx に写す。
        throw new AssetRehostError(`asset fetch returned ${res.status}`);
      }
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength === 0) {
        throw new AssetRehostError("asset fetch returned empty body");
      }
      if (arrayBuf.byteLength > MAX_ASSET_BYTES) {
        throw new AssetRehostError(`asset too large: ${arrayBuf.byteLength} bytes`);
      }
      const body = Buffer.from(arrayBuf);

      // 2. 公開バケットへ保存（transient: GCS 障害 → AssetRehostError → route 5xx）。
      const objectPath = `${prefix}/${objectId}`;
      try {
        await bucket.file(objectPath).save(body, { contentType, resumable: false });
      } catch (cause) {
        throw new AssetRehostError("asset upload failed", { cause });
      }

      // 3. 公開 read URL（ad_media バケットは allUsers:objectViewer・公開掲示物）。
      return `https://storage.googleapis.com/${config.bucket}/${objectPath}`;
    },
  };
}

let cached: AssetRehostPort | null = null;

/**
 * プロセス共有の既定 re-host ポート。env `AD_MEDIA_BUCKET` があれば GCS 再ホスト、無ければ passthrough（暫定）。
 * route から使う。バケット未配線（env 欠落）でも受け口を止めない（passthrough）= 受信ロスを防ぐ（要件2）。
 */
export function getAssetRehost(): AssetRehostPort {
  if (!cached) {
    const bucket = process.env.AD_MEDIA_BUCKET ?? "";
    cached = bucket ? createGcsAssetRehost({ bucket }) : createPassthroughAssetRehost();
  }
  return cached;
}

/** テスト用: プロセスキャッシュをリセットする。 */
export function resetAssetRehostCacheForTest(): void {
  cached = null;
}
