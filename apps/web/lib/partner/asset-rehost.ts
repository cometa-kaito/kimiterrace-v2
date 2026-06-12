import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { Storage } from "@google-cloud/storage";
import { AD_MEDIA_OBJECT_PREFIX, adMediaServingPath, isValidAdMediaKey } from "../ads/media-object";
import { isBlockedInternalHost } from "../tv/config-edit-core";

/**
 * Partner API K3（`docs/api/partner-api-contract.md` §3）: portal が渡す **短命署名 URL**（`assetFetchUrl`、
 * Supabase 署名 URL・約 10 分有効）の広告クリエイティブを v2 が取得し、**公開 ad-media バケットへ再ホスト**して
 * 永続の配信 URL（`ads.media_url`）を返すポート。
 *
 * ## なぜ再ホストするか
 * `assetFetchUrl` は短命（10 分）なので、そのまま `media_url` に保存するとサイネージ端末が後で GET したとき
 * 失効している。サイネージは `ads.media_url` を `<img>`/`<video>` で**直接 GET** する（公開掲示物・PII 無し、
 * `infrastructure/terraform/modules/ad_media` の公開バケット）。よって取得 → 公開バケットへ保存 → その配信 URL を
 * 返す必要がある。広告は企業の認知広告であり生徒 PII を含まない（教員アップロード `UPLOAD_BUCKET` の per-school
 * 非公開素材とは正反対のポリシー、ad_media モジュール doc）。
 *
 * ## 配信 URL は同一オリジン `/ad-media/<key>`（ADR-037）
 * サイネージ実機は県教委 Wi-Fi の **FQDN 許可リスト**下にあり `app.school-signage.net` のみ到達可で、
 * `storage.googleapis.com` 直 URL は遮断されうる。そのため `/admin` アップロード経路（`/api/ads/media`）と同じく、
 * 保存キーは `ads/partner/<portalPlacementId>`、`media_url` には同一オリジン相対パス
 * `/ad-media/ads/partner/<id>`（`adMediaServingPath`）を返す。配信 Route（`app/ad-media/[...key]/route.ts`）が
 * バケットから stream する。GCS 直 URL を返していた旧実装の partner 広告は、portal からの再配信（冪等 upsert）で
 * 同一オリジン URL に置き換わる。
 *
 * ## 【要件2】エラー方針（portal の再送判断: 4xx=fatal / 5xx=transient）
 * `assetFetchUrl` の取得失敗（署名 URL 期限切れ・ネットワーク断）と GCS アップロード失敗は **transient**
 * （再送で回復しうる）= route で **5xx**。`AssetRehostError` を投げ、route が 502/500 に写す。恒久不整合
 * （payload 不正等）はここに来る前に route のバリデーションで 4xx として弾く。
 * SSRF ポリシー違反（非 https・内部ホスト/IP・DNS-rebinding・リダイレクト）は **恒久** = `AssetPolicyError`、
 * route が **4xx**（再送しても直らない・無限再送を防ぐ）。
 *
 * ## SSRF（重要・PR #816 Reviewer B-1 / config-edit-core.ts §SSRF）
 * `assetFetchUrl` は外部 portal 由来の値をサーバー側 fetch するシンク。Cloud Run のメタデータサーバ
 * （`169.254.169.254`）から SA トークンを盗む HIGH severity SSRF になりうる。`createGcsAssetRehost` は fetch 前に
 * `assertPublicHttpsTarget` で https 限定 + ホスト名リテラル + **解決済み IP** を `isBlockedInternalHost` で
 * 内部レンジと突合（DNS-rebinding 対策）し、`redirect:'manual'` でリダイレクトを追わない。
 *
 * ## passthrough フォールバック（`AD_MEDIA_BUCKET` 未設定の env のみ）
 * 公開 ad-media バケットは Terraform `modules/ad_media` で **staging/prod とも enabled=true・
 * `AD_MEDIA_BUCKET` 注入済み**（2026-06-08 bring-up・#46/#48-F）。バケット未配線の env（ローカル等）に限り
 * **再ホストせず assetFetchUrl をそのまま** `media_url` として返す（受け口を止めない・要件2）。
 * 署名 URL は短命のため passthrough は短期検証用途専用。
 */

/** 取得 / アップロードの transient 失敗（要件2: route が 5xx に写す）。 */
export class AssetRehostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssetRehostError";
  }
}

/**
 * asset URL のポリシー違反（**恒久**・要件2: route が 4xx に写す）。再送で直らない:
 * 非 https / 内部ホスト・内部 IP（SSRF）/ 内部へ解決する公開名（DNS-rebinding）/ リダイレクト / 不正キー。
 */
export class AssetPolicyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssetPolicyError";
  }
}

/** DNS lookup の注入形（テスト用）。`node:dns/promises` の `lookup(host,{all:true})` と互換。 */
export type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;

/**
 * **SSRF ガード（fetch 時の宛先検証）**: `fetchUrl` が https の外部公開ホストであることを保証する。
 * 保存時検証に依存せず、`isBlockedInternalHost`（loopback/link-local/RFC1918/メタデータ/IPv4-mapped IPv6 を網羅）で
 * **ホスト名リテラルと解決済み IP の両方**を内部レンジと突合する（DNS-rebinding 対策）。違反は `AssetPolicyError`
 * （恒久・route 4xx）。DNS 解決自体の失敗は `AssetRehostError`（transient・route 5xx）。
 */
export async function assertPublicHttpsTarget(
  fetchUrl: string,
  lookupAll: LookupAll,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(fetchUrl);
  } catch {
    throw new AssetPolicyError("asset url invalid");
  }
  if (url.protocol !== "https:") {
    throw new AssetPolicyError("asset url must be https");
  }
  // 1. ホスト名リテラル（内部 IP・metadata.google.internal 等）を弾く。
  if (isBlockedInternalHost(url.hostname)) {
    throw new AssetPolicyError("asset host is internal");
  }
  // 2. DNS 解決し、全 IP を内部レンジと突合（公開名が内部 IP へ解決する DNS-rebinding を遮断）。
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookupAll(url.hostname);
  } catch (cause) {
    throw new AssetRehostError("asset host resolve failed", { cause });
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedInternalHost(a.address))) {
    throw new AssetPolicyError("asset host resolves to internal address");
  }
  return url;
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

/** asset 取得のタイムアウト（内部宛先での hang や巨大取得を防ぐ）。 */
const FETCH_TIMEOUT_MS = 15_000;

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
  /**
   * 保存キーの prefix（既定 `ads/partner`）。`ads/` 始まりは配信 Route（`/ad-media/<key>`）が
   * serve する条件（`isValidAdMediaKey`・ADR-037）。`/partner` でアップロード経路（`ads/<schoolId>/…`）
   * と出所を分ける（schoolId は UUID のため衝突しない）。
   */
  prefix?: string;
  /** 注入用 `@google-cloud/storage` クライアント（テスト/モック用）。未指定なら ADC で生成。 */
  storage?: Storage;
  /** 取得に使う fetch（テスト注入用）。未指定なら global fetch。 */
  fetchImpl?: typeof fetch;
  /** DNS 解決（テスト注入用）。未指定なら `node:dns/promises` の lookup(all:true)。SSRF の IP 検証に使う。 */
  lookupImpl?: LookupAll;
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
  const prefix = config.prefix ?? `${AD_MEDIA_OBJECT_PREFIX}/partner`;
  const doFetch = config.fetchImpl ?? fetch;
  const lookupAll: LookupAll = config.lookupImpl ?? ((h) => lookup(h, { all: true }));

  return {
    async rehost(fetchUrl: string, objectId: string): Promise<string> {
      if (!SAFE_OBJECT_ID.test(objectId) || objectId.includes("..")) {
        // 呼出側のキー生成不正（恒久・route 4xx）。route 到達前に portalPlacementId を UUID 検証済みのため
        // 通常到達しないが、多層防御として明示。
        throw new AssetPolicyError(`不正な objectId: ${objectId}`);
      }

      // 0. SSRF ガード: https の外部公開ホストのみ許可（内部 IP・メタデータ・DNS-rebinding を遮断）。恒久違反は 4xx。
      const target = await assertPublicHttpsTarget(fetchUrl, lookupAll);

      // 1. 取得（transient: 署名 URL 失効・ネットワーク断 → AssetRehostError → route 5xx）。
      //    redirect:'manual' でリダイレクトを追わない（公開→内部 IP への 30x 迂回を遮断、SSRF）。
      let res: Response;
      try {
        res = await doFetch(target, {
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (cause) {
        throw new AssetRehostError("asset fetch failed", { cause });
      }
      if (res.status >= 300 && res.status < 400) {
        // リダイレクトは追わない（内部宛先への 30x 迂回を防ぐ・恒久）。
        throw new AssetPolicyError("asset url redirected");
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
      // キーは **内容アドレス**: `<prefix>/<objectId>-<sha256先頭16hex>`。配信 Route は
      // `immutable` 長期キャッシュ（+ SW cache-first）を返すため、placement 固定のキーだと
      // クリエイティブ差し替え時に実機が旧画像を実質無期限に保持してしまう（Reviewer M-1）。
      // 内容が変われば URL が変わり（自然なキャッシュバスト）、同一内容の再送は同一キー（冪等）。
      // 旧内容のオブジェクトは無害な孤児として残る（公開掲示物・PII なし）。
      const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
      const objectPath = `${prefix}/${objectId}-${digest}`;
      // 生成キーは配信 Route の受理条件（isValidAdMediaKey）を必ず満たすことを多層防御で確認。
      if (!isValidAdMediaKey(objectPath)) {
        throw new AssetPolicyError(`不正な object key: ${objectPath}`);
      }
      try {
        await bucket.file(objectPath).save(body, { contentType, resumable: false });
      } catch (cause) {
        throw new AssetRehostError("asset upload failed", { cause });
      }

      // 3. 同一オリジン配信パス `/ad-media/<key>` を返す（ADR-037・FQDN 許可リスト対応）。
      //    サイネージ・管理画面とも app.school-signage.net 配下で解決される相対 URL。
      return adMediaServingPath(objectPath);
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
