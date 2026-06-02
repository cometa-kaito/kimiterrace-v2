import { type ReportDownloadPort, createGcsReportDownload } from "./storage-download";

/**
 * F09 (#45 / #430): 月次レポート DL ポート (`ReportDownloadPort`) のプロセス内シングルトン解決。
 *
 * バケット名は env `REPORT_BUCKET` から解決する (ハードコード禁止・ルール5。Terraform `report_storage`
 * #467 の出力を Cloud Run env に注入)。認証は Workload Identity (ADC、JSON キー不使用・ルール5)。
 * Route Handler はこの解決器に依存し、テストでは `@/lib/reports/download-port` をモックして GCS / 認証
 * なしで配線を検証する (jobs 側の storage port と同じ DI 方針)。
 */

/**
 * DL バケット名 (env)。未設定はサーバー設定不備として throw (CLAUDE.md ルール5)。
 * 本番は Cloud Run env (Terraform 注入)、ローカル/テストは .env.local で設定する。
 */
function resolveReportBucket(): string {
  const bucket = process.env.REPORT_BUCKET;
  if (!bucket) {
    throw new Error(
      "REPORT_BUCKET is not set. 月次レポート保存バケット名を env で注入する (Terraform report_storage #467 / CLAUDE.md ルール5)。",
    );
  }
  return bucket;
}

let cached: ReportDownloadPort | null = null;

/** プロセス内で使い回す `ReportDownloadPort` を返す (GCS クライアントの再生成を避ける)。 */
export function getReportDownloadPort(): ReportDownloadPort {
  if (cached) {
    return cached;
  }
  cached = createGcsReportDownload({ bucket: resolveReportBucket() });
  return cached;
}
