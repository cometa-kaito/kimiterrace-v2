import { env, exit } from "node:process";
import { type RunMonthlyReportsConfig, runMonthlyReports } from "./run.js";

/**
 * F09 (#45 第3スライス): 月次レポート PDF 生成バッチの Cloud Run Job エントリ。
 *
 * 使い方: `node src/reports/report-job.ts`（Cloud Run Job のコンテナ起動コマンド）。月初に前月分を
 * 生成する運用を想定し、対象年月は env で受ける（どの月を生成するかは Cloud Scheduler / Job の
 * 引数決定 = deploy の責務）。ロジックは `run.ts`（`runMonthlyReports` / `renderAllMonthlyReports`、
 * フェイクで単体検証可能）に置き、本ファイルは env 読取・構造化ログ・終了コードの I/O 結線のみに
 * 徹する（`embedding/embed-job.ts` と同じ分離）。
 *
 * **本スライスの範囲**: 全校の PDF を生成し（#429/#415）、**生成済 PDF を Cloud Storage へ保存（ADR-018）し
 * `monthly_reports` に生成履歴を upsert する（#430）**まで。生成メトリクス（校ごとの PDF バイト数・保存 path・
 * 履歴行 id）を構造化ログに残す。配布（メール/apps/web の DL 導線）と Terraform（バケット/Scheduler/
 * lifecycle）は後続スライス。
 *
 * 必須 env:
 * - `DATABASE_URL`: **kimiterrace_app ロール**（非 BYPASSRLS）。Secret Manager 経由で注入し、
 *   コード/コミットされる env にハードコードしない（ルール2・5）。
 * - `REPORT_BUCKET`: PDF 保存先 Cloud Storage バケット名。ハードコードせず env で注入（ルール5）。認証は
 *   Cloud Run の Workload Identity（ADC、JSON キー不要・ルール5）。
 * - `REPORT_YEAR`: 対象年（西暦、例 2026）。整数のみ。
 * - `REPORT_MONTH`: 対象月（1-12）。範囲外は集計クエリが `RangeError`。
 */

/** 必須 env を取得する（未設定は throw）。 */
function requireEnv(name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(
      `${name} が未設定です。Secret Manager / Cloud Run Job env で注入してください。`,
    );
  }
  return v;
}

/** 必須 env を整数として取得する（非整数は throw）。 */
function requireIntEnv(name: string): number {
  const raw = requireEnv(name).trim();
  const n = Number.parseInt(raw, 10);
  // "12abc" や "" を弾く（parseInt は前方一致で 12 を返すため、往復一致で厳密検証する）。
  if (!Number.isInteger(n) || String(n) !== raw) {
    throw new Error(`${name} は整数で指定してください (got ${JSON.stringify(raw)})`);
  }
  return n;
}

/**
 * エラーメッセージから接続文字列 (DSN) を伏せる（ルール5: secret をログに出さない）。
 * postgres 接続エラーは host / 認証情報を message に含めうるため、URL を一律マスクする。
 */
function redactDsn(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s"]+/gi, "postgres://<redacted>");
}

async function main(): Promise<void> {
  const config: RunMonthlyReportsConfig = {
    databaseUrl: requireEnv("DATABASE_URL"),
    bucket: requireEnv("REPORT_BUCKET"),
    year: requireIntEnv("REPORT_YEAR"),
    month: requireIntEnv("REPORT_MONTH"),
  };

  const { generated, persisted } = await runMonthlyReports(config);
  // **PDF バイト列はログに出さない**（巨大・不要）。生成メトリクス（校ごとの PDF サイズ・GCS 保存 path・
  // 履歴行 id）だけを構造化ログに残す（Cloud Logging）。secret / PII は含めない（校名は機関識別であり
  // 個人情報でない。バケット名・object path は機密でなく、運用調査に必要）。
  console.info(
    JSON.stringify({
      event: "report.monthly.done",
      year: generated.year,
      month: generated.month,
      schools: generated.schools,
      reports: persisted.persisted.map((p) => ({
        schoolId: p.schoolId,
        pdfSizeBytes: p.pdfSizeBytes,
        storagePath: p.storagePath,
        reportId: p.reportId,
      })),
    }),
  );
}

main().catch((err) => {
  const message = redactDsn(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error(JSON.stringify({ event: "report.monthly.error", message }));
  exit(1);
});
