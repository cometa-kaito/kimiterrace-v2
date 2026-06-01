import { Storage } from "@google-cloud/storage";

/**
 * F09 (#45 / #430): 生成済 月次レポート PDF の **Cloud Storage 保存ポート** (ADR-018)。
 *
 * 最大数 MB の PDF を 10 年保管するのは Cloud SQL に不向きなため、PDF 本体は Cloud Storage に置き、
 * `monthly_reports` 表には保存 path だけを持つ (`monthly-reports.ts` の設計)。本モジュールは保存先 path の
 * **決定論的な規約** (`buildReportObjectPath`) と、`@google-cloud/storage` への薄い保存アダプタ
 * (`createGcsReportStorage`) を提供する。ドライバ (`reports/run.ts`) はこのポート interface に依存し、
 * テストではフェイク storage を注入して GCS / 認証なしで保存の配線を検証できる (embedding port と同じ構成)。
 *
 * ## バケット名は env (ルール5)
 * バケット名はコードにハードコードせず、entrypoint (`report-job.ts`) が env (`REPORT_BUCKET`) で受けて
 * 注入する。認証は Cloud Run の Workload Identity (ADC) に委ね、JSON キーファイルは配布しない (ルール5)。
 *
 * ## 保存 path 規約 (#430 設計判断)
 * `reports/{year}/{month2}/{schoolId}.pdf` (month はゼロ詰め 2 桁)。
 * - **決定論的**: 同一 (校, 年, 月) は常に同じ object path。Job 再実行で同 path を上書きし、孤児オブジェクトを
 *   作らない (`monthly_reports` の upsert と整合する冪等性)。
 * - **校 id を path に含む**: 一覧/監査時に school で前方一致でき、`{year}/{month}` 接頭辞で月単位の
 *   lifecycle ルール (コールド移送 / 失効) を Terraform 側で後付けしやすい (lifecycle は別スライス)。
 * - 年月は集計クエリで範囲検証済の int を受ける前提だが、path 生成側でも基本的な健全性を確認する。
 */

/** PDF を保存先へ書き込む最小ポート (実体は GCS、テストはフェイク)。 */
export interface ReportStoragePort {
  /**
   * 1 校 1 か月分の PDF を保存する。
   * @param objectPath バケット内の object path (`buildReportObjectPath` で生成した決定論的 path)。
   * @param pdf PDF バイト列 (`renderMonthlyReportPdf` の出力)。
   */
  save(objectPath: string, pdf: Buffer): Promise<void>;
}

/**
 * 保存先 object path を決定論的に組み立てる。同一 (schoolId, year, month) は常に同じ path。
 *
 * @throws RangeError year が非整数、month が 1-12 外、schoolId が空のとき (壊れた path で保存しない)。
 */
export function buildReportObjectPath(schoolId: string, year: number, month: number): string {
  if (!Number.isInteger(year) || year < 1) {
    throw new RangeError(`buildReportObjectPath: year が不正 (${year})`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`buildReportObjectPath: month が不正 (${month}), 1-12 で指定`);
  }
  if (!schoolId) {
    throw new RangeError("buildReportObjectPath: schoolId が空");
  }
  const month2 = String(month).padStart(2, "0");
  return `reports/${year}/${month2}/${schoolId}.pdf`;
}

/** `createGcsReportStorage` の設定。 */
export type GcsReportStorageConfig = {
  /** 保存先バケット名 (env `REPORT_BUCKET` 由来、ハードコード禁止・ルール5)。 */
  bucket: string;
  /**
   * 注入用の `@google-cloud/storage` クライアント (テストやモック用)。未指定なら ADC で生成する
   * (Cloud Run の Workload Identity、JSON キー不要・ルール5)。
   */
  storage?: Storage;
};

/**
 * `@google-cloud/storage` を使う `ReportStoragePort` の実装。
 *
 * 保存はバケット内 object を `application/pdf` で上書き保存する (`file.save`)。同一 path への再保存は
 * 上書き = 冪等。バケット名は env 注入、認証は ADC (Workload Identity)。
 */
export function createGcsReportStorage(config: GcsReportStorageConfig): ReportStoragePort {
  if (!config.bucket) {
    throw new Error(
      "createGcsReportStorage: bucket が空です (env REPORT_BUCKET を設定してください)",
    );
  }
  const storage = config.storage ?? new Storage();
  const bucket = storage.bucket(config.bucket);
  return {
    async save(objectPath, pdf) {
      await bucket.file(objectPath).save(pdf, {
        contentType: "application/pdf",
        resumable: false,
      });
    },
  };
}
