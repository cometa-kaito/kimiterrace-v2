import { Storage } from "@google-cloud/storage";

/**
 * F09 (#45 / #430): 生成済 月次レポート PDF の **Cloud Storage 読み取りポート** (ADR-018)。
 *
 * 生成バッチ (apps/jobs `reports/storage.ts`) が `reports/{year}/{month2}/{schoolId}.pdf` に保存した
 * PDF 本体を、system_admin の DL Route Handler が **認証済みレスポンスとしてストリーム返却**するための
 * 薄い読み取りアダプタ。`@google-cloud/storage` へのアクセスをこのポート interface に閉じ込め、Route
 * Handler はテストでフェイク storage を注入できる (jobs 側の保存ポートと対になる構成)。
 *
 * ## 署名 URL を採らない (security-first / ルール5)
 * GCS の公開署名 URL (V4 signed URL) は発行すると **URL を知る誰でも (認証なしで) 取得できる**
 * 共有可能トークンになる。生徒データを含みうる校別レポートでは、URL 漏洩 = 認証境界の外で PDF が
 * 流通するリスクになる。本プロジェクトの security-first 方針に従い、署名 URL を発行せず、Route が
 * Workload Identity (ADC) で GCS からオブジェクトを読み、**認証済みセッションのレスポンスとして
 * stream する**。トークン/URL をクライアントへ露出しない (ルール5)。
 *
 * ## バケット名は env (ルール5)
 * バケット名はコードにハードコードせず、env (`REPORT_BUCKET`) で受けて注入する (Terraform
 * `report_storage` モジュール #467 の出力)。認証は Cloud Run の Workload Identity (ADC) に委ね、
 * JSON キーファイルは配布しない (ルール5)。
 */

/** GCS から取得した PDF のストリーム + メタ。Route Handler が Response body へそのまま流す。 */
export type ReportDownload = {
  /** PDF バイト列の Web ReadableStream (Response body へ pipe する)。 */
  body: ReadableStream<Uint8Array>;
  /** Content-Type (application/pdf)。 */
  contentType: string;
  /** バイト数 (取得できれば Content-Length に使う)。 */
  contentLength?: number;
};

/** 月次レポート PDF を保存先から読み出す最小ポート (実体は GCS、テストはフェイク)。 */
export interface ReportDownloadPort {
  /**
   * 保存済 object を読み出す。存在しなければ `null` (Route は 404 に写像)。
   * @param objectPath バケット内の object path (`monthly_reports.pdf_storage_path`)。
   */
  fetch(objectPath: string): Promise<ReportDownload | null>;
}

/** `createGcsReportDownload` の設定。 */
export type GcsReportDownloadConfig = {
  /** 保存元バケット名 (env `REPORT_BUCKET` 由来、ハードコード禁止・ルール5)。 */
  bucket: string;
  /**
   * 注入用の `@google-cloud/storage` クライアント (テストやモック用)。未指定なら ADC で生成する
   * (Cloud Run の Workload Identity、JSON キー不要・ルール5)。
   */
  storage?: Storage;
};

/** GCS の "not found" エラー (code=404)。drizzle 同様 cause も見る。 */
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
 * `@google-cloud/storage` を使う `ReportDownloadPort` の実装。
 *
 * `file.createReadStream()` (Node Readable) を Web `ReadableStream` へ変換して返し、Route Handler が
 * Response body へ stream する (全量をメモリへ載せない)。存在しないオブジェクトは `null`。バケット名は
 * env 注入、認証は ADC (Workload Identity)。
 */
export function createGcsReportDownload(config: GcsReportDownloadConfig): ReportDownloadPort {
  if (!config.bucket) {
    throw new Error(
      "createGcsReportDownload: bucket が空です (env REPORT_BUCKET を設定してください)",
    );
  }
  const storage = config.storage ?? new Storage();
  const bucket = storage.bucket(config.bucket);
  return {
    async fetch(objectPath) {
      const file = bucket.file(objectPath);
      try {
        const [metadata] = await file.getMetadata();
        const nodeStream = file.createReadStream();
        // Node Readable → Web ReadableStream。Response body に渡せる形にする。
        const body = nodeStreamToWeb(nodeStream);
        const sizeRaw = metadata.size;
        const contentLength =
          typeof sizeRaw === "string" ? Number.parseInt(sizeRaw, 10) : (sizeRaw ?? undefined);
        return {
          body,
          contentType: metadata.contentType ?? "application/pdf",
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
 * Node の Readable を Web の ReadableStream<Uint8Array> へ変換する。
 *
 * Node 18+ の `Readable.toWeb` を使う (Cloud Run / Next の Node ランタイム前提)。型は最小限に絞り、
 * `as any` を使わずに `Readable.toWeb` の存在を narrowing する (ルール3)。
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
  // フォールバック: 手動でブリッジ (古い Node / 一部の stream 実装)。
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
