import type { InferInsertModel } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { monthlyReports } from "../schema/monthly-reports.js";

/**
 * F09 (#45 / #430): 月次レポート生成履歴 (`monthly_reports`) への **書き込み層**。**INSERT/UPSERT のみ**。
 *
 * 生成済 PDF を Cloud Storage へ保存したあと、その保存 path・対象年月・PDF バイト数・生成時メトリクスを
 * `monthly_reports` に 1 行記録する (生成履歴 = 配布・再生成・コールド移送の起点となる台帳)。読み取り集計層
 * (`monthly-report.ts`) と対になる mutation 層で、Cloud Run Job のドライバ (apps/jobs `reports/run.ts`) が
 * **校ごとに `withTenantContext` 内で**本関数を呼ぶ。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `school_id` を **WHERE/INSERT 条件に手書きしない** — 呼び出し接続の RLS コンテキスト
 * (`app.current_school_id`、ADR-019) が `tenant_isolation` policy (FOR ALL の WITH CHECK) で越境 INSERT を
 * DB レベルで弾く。必ず **school_admin に降格した** context で呼ぶこと (`system_admin` は
 * `system_admin_full_access` が全校 PERMISSIVE に発火し越境するため不可)。BYPASSRLS 不使用。values に渡す
 * `schoolId` は接続コンテキストの `app.current_school_id` と一致する必要がある (不一致は WITH CHECK で拒否)。
 *
 * ## 冪等性 (#430 設計判断)
 * `(school_id, target_year, target_month)` の unique 制約 (`ux_monthly_reports_school_year_month`) を競合キーに
 * `onConflictDoUpdate` で **upsert** する。同一年月の Job 再実行 (リトライ / 月初の再走) で重複行を作らず、
 * 最新の保存 path・サイズ・メトリクスへ差し替える (生成は冪等という `embedding/run.ts` と同じ運用方針)。
 * UPDATE 分岐では `updated_at` を明示更新する (ルール1: `auditColumns.updatedAt` は INSERT 既定のみで
 * `$onUpdate`/トリガを持たないため、明示しないと作成時刻のまま残り監査不整合になる)。`generated_at` も
 * 再生成時刻へ更新する (履歴上「いつ作り直したか」を正とする)。`created_at` / `created_by` は初回値を保つ。
 *
 * ## 監査 (ルール1)
 * `created_by` / `updated_by` は **null** (人間 actor の無いシステムバッチによる生成のため、auditColumns の
 * 「システム作成は null」規約に従う)。行自体が「いつ・どの校の・何年何月分を・どこへ保存したか」の台帳で、
 * `audit_log` への二重記録は行わない (ai_extractions / embedding 派生更新と同方針)。
 *
 * 関連: ADR-018 (PDF を Storage 退避), F09 (docs/requirements/functional/F09-monthly-report.md), #429 (PDF
 * 純関数), #415 (集計読取), GCS 保存ドライバ (apps/jobs `reports/storage.ts` / `reports/run.ts`)。
 */

/**
 * `monthly_reports` INSERT 用の値。型は Drizzle スキーマを単一ソースとする (ルール3)。
 * `id` / `created_at` / `updated_at` / `generated_at` は DB 既定 (gen_random_uuid / now) のため省略可。
 */
export type NewMonthlyReport = InferInsertModel<typeof monthlyReports>;

/**
 * 月次レポート生成履歴 1 件を `monthly_reports` に upsert する (#430)。
 *
 * **必ず school_admin 降格の RLS コンテキスト (`withTenantContext`) 内で呼ぶこと。** `school_id` は接続
 * コンテキストの `app.current_school_id` と一致する必要があり、`tenant_isolation` policy の WITH CHECK が
 * 越境 INSERT を DB レベルで弾く。同一 `(school_id, target_year, target_month)` の再実行は upsert で
 * 既存行を更新する (冪等)。
 *
 * @returns upsert 後の行 id
 */
export async function insertMonthlyReport(
  tx: TenantTx,
  values: NewMonthlyReport,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(monthlyReports)
    .values({ ...values, createdBy: null, updatedBy: null })
    .onConflictDoUpdate({
      target: [monthlyReports.schoolId, monthlyReports.targetYear, monthlyReports.targetMonth],
      set: {
        pdfStoragePath: values.pdfStoragePath,
        pdfSizeBytes: values.pdfSizeBytes,
        metricsSnapshot: values.metricsSnapshot,
        // 再生成時刻と監査列を更新 (ルール1: updated_at を明示更新)。created_at / created_by は初回値を保つ。
        generatedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: null,
      },
    })
    .returning({ id: monthlyReports.id });
  if (!row) {
    throw new Error("monthly_reports の追記に失敗しました (returning が空)");
  }
  return row;
}
