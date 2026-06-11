import { Storage } from "@google-cloud/storage";

/**
 * サイネージ広告メディアの **公開バケット読み取りポート**（#46 / ADR-037）。
 *
 * 配信 Route（`app/ad-media/[...key]/route.ts`）が、公開 ad-media バケットのオブジェクトを
 * **同一オリジン（`app.school-signage.net`）からの stream として返す**ための薄い読み取りアダプタ。
 * `@google-cloud/storage` へのアクセスをこのポート interface に閉じ込め、Route はテストでフェイク
 * storage を注入できる（reports の `ReportDownloadPort` と対の構成）。
 *
 * ## reports の DL ポートとの差分（公開掲示物ゆえ正反対のポリシー）
 * 月次レポートは生徒データを含みうるため署名 URL を避け `Cache-Control: no-store` で認証境界内に閉じる。
 * 広告クリエイティブは **公開掲示物（企業の認知広告・PII 無し）** であり、本ポートが返すバイト列は配信
 * Route 側で **長期キャッシュ可（immutable）** として扱う。バケット名は env（`AD_MEDIA_BUCKET`）注入・認証は
 * Workload Identity（ADC）、JSON キーは配布しない（ルール5）。
 */

/** GCS から取得した広告メディアのストリーム + メタ。Route が Response body へそのまま流す。 */
export type AdMediaDownload = {
  /** メディアのバイト列（Web ReadableStream・Response body へ pipe する）。 */
  body: ReadableStream<Uint8Array>;
  /** Content-Type（保存時に設定した MIME。image/png 等）。 */
  contentType: string;
  /** バイト数（取得できれば Content-Length に使う）。 */
  contentLength?: number;
};

/** 広告メディアを保存先から読み出す最小ポート（実体は GCS、テストはフェイク）。 */
export interface AdMediaDownloadPort {
  /**
   * 保存済 object を読み出す。存在しなければ `null`（Route は 404 に写像）。
   * @param objectKey バケット内の object key（`ads/...` の接頭辞配下）。
   */
  fetch(objectKey: string): Promise<AdMediaDownload | null>;
}

/** `createGcsAdMediaDownload` の設定。 */
export type GcsAdMediaDownloadConfig = {
  /** 読み取り元バケット名（env `AD_MEDIA_BUCKET` 由来、ハードコード禁止・ルール5）。 */
  bucket: string;
  /** 注入用の `@google-cloud/storage` クライアント（テスト/モック用）。未指定なら ADC で生成。 */
  storage?: Storage;
};

/** GCS の "not found"（code=404）。drizzle 同様 cause も見る。 */
function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  if (e && (e.code === 404 || e.code === "404")) {
    return true;
  }
  if (e?.cause && (e.cause.code === 404 || e.cause.code === "404")) {
    return true;
  }
  return false;
}

/**
 * `@google-cloud/storage` を使う `AdMediaDownloadPort` の実装。
 *
 * `file.createReadStream()`（Node Readable）を Web `ReadableStream` へ変換して返し、Route が Response body へ
 * stream する（全量をメモリへ載せない）。存在しないオブジェクトは `null`。バケット名は env 注入・認証は ADC。
 */
export function createGcsAdMediaDownload(config: GcsAdMediaDownloadConfig): AdMediaDownloadPort {
  if (!config.bucket) {
    throw new Error(
      "createGcsAdMediaDownload: bucket が空です (env AD_MEDIA_BUCKET を設定してください)",
    );
  }
  const storage = config.storage ?? new Storage();
  const bucket = storage.bucket(config.bucket);
  return {
    async fetch(objectKey) {
      const file = bucket.file(objectKey);
      try {
        const [metadata] = await file.getMetadata();
        const nodeStream = file.createReadStream();
        const body = nodeStreamToWeb(nodeStream);
        const sizeRaw = metadata.size;
        const contentLength =
          typeof sizeRaw === "string" ? Number.parseInt(sizeRaw, 10) : (sizeRaw ?? undefined);
        return {
          body,
          contentType: metadata.contentType ?? "application/octet-stream",
          contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
        };
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}

/**
 * Node の Readable を Web の ReadableStream<Uint8Array> へ変換する（reports の同名ヘルパと同方針）。
 * Node 18+ の `Readable.toWeb` を使い、無ければ手動ブリッジにフォールバックする（`as any` を使わない・ルール3）。
 */
function nodeStreamToWeb(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  const toWeb = (
    nodeStream as unknown as {
      toWeb?: () => ReadableStream<Uint8Array>;
    }
  ).toWeb;
  if (typeof toWeb === "function") {
    return toWeb.call(nodeStream);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      (nodeStream as unknown as { destroy?: () => void }).destroy?.();
    },
  });
}
