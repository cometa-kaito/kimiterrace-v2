import { type InferSelectModel, asc, desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { monthlyReports } from "../schema/monthly-reports.js";
import { schools } from "../schema/schools.js";

/**
 * F09 (#45 / #430): 月次レポート生成履歴 (`monthly_reports`) の **読み取り層**。**SELECT のみ**。
 *
 * 生成バッチ (apps/jobs `reports/run.ts`) が PDF を Cloud Storage へ保存し `monthly_reports` に
 * 記録した履歴を、**管理者が一覧 / 単件取得して PDF を DL する導線** (apps/web の system_admin
 * レポート画面 + DL Route Handler) に供給する。書き込み層 (`monthly-reports-write.ts`) と対になる
 * 参照専用モジュール。mutation は持たない。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `school_id` 条件を **手書きしない** — 呼び出し接続の RLS コンテキスト (`app.current_user_role` /
 * `app.current_school_id`、ADR-019) が DB レベルで可視範囲を強制する。monthly_reports には 2 policy
 * がある (0002_rls_policies.sql):
 * - `system_admin_full_access` (role=system_admin) → **全校横断 SELECT 可**
 * - `tenant_isolation` (school_id = current_school_id) → 自校のみ SELECT
 * したがって本モジュールは role/school を WHERE に書かず RLS に委ねる。system_admin の全校一覧では
 * **降格しない** (`tenantScoped` を指定しない) ことで `system_admin_full_access` が全校に発火する。
 * `getMonthlyReport(id)` の `WHERE id` は**対象特定**の条件であってテナント境界ではない (他校 id を
 * 渡しても tenant ロールには 0 行で見えない / system_admin は全校可視)。呼び出し側は RLS をバイパス
 * しない接続ロール (kimiterrace_app) を使うこと。**BYPASSRLS 不使用**。
 *
 * ## 結合 (校名)
 * 一覧/単件とも校名を出すため `schools` を INNER JOIN する。schools にも `system_admin_full_access` /
 * `tenant_self_read` があり、monthly_reports と同じ可視範囲で絞られるため結合で越境は起きない。
 *
 * ## PII / 監査 (ルール4 / NFR04)
 * 返すのは校名・対象年月・保存 path・PDF バイト数・生成時刻 (= 台帳メタ) のみで、`metrics_snapshot`
 * 等の本文は読まない。個人を再識別しうる値は含まない。DL 操作自体の監査は呼び出し側 (Route Handler)
 * が `audit_log` に記録する (ルール1)。
 *
 * 型は schema (`monthlyReports` / `schools`) から `InferSelectModel` で派生する (ルール3)。
 * 関連: ADR-018 (PDF を Storage 退避), F09 (docs/requirements/functional/F09-monthly-report.md),
 * 書き込み層 (`monthly-reports-write.ts`, #465), Terraform `report_storage` バケット (#467)。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type MonthlyReportRow = InferSelectModel<typeof monthlyReports>;

/**
 * 月次レポート履歴 1 行の read モデル (一覧 / 単件共通)。校名 + DL に必要なメタのみの軽量射影。
 * `metricsSnapshot` / `aiCommentary` 等の本文は含めない (一覧/DL には不要、ルール4)。
 */
export type MonthlyReportListItem = Pick<
  MonthlyReportRow,
  | "id"
  | "schoolId"
  | "targetYear"
  | "targetMonth"
  | "pdfStoragePath"
  | "pdfSizeBytes"
  | "generatedAt"
> & {
  /** 所属校名 (schools 結合)。一覧表示用。 */
  schoolName: string;
};

const LIST_COLUMNS = {
  id: monthlyReports.id,
  schoolId: monthlyReports.schoolId,
  schoolName: schools.name,
  targetYear: monthlyReports.targetYear,
  targetMonth: monthlyReports.targetMonth,
  pdfStoragePath: monthlyReports.pdfStoragePath,
  pdfSizeBytes: monthlyReports.pdfSizeBytes,
  generatedAt: monthlyReports.generatedAt,
} as const;

/**
 * 月次レポート生成履歴を一覧する。可視範囲は RLS が決める (system_admin=全校 / テナント=自校のみ)。
 *
 * 並びは対象年 → 対象月の降順 (新しい月が先)、同月内は校名 → id 昇順で決定的に並べる
 * (同年月で複数校が並んでも順序が安定する)。
 */
export async function listMonthlyReports(db: Selectable): Promise<MonthlyReportListItem[]> {
  return db
    .select(LIST_COLUMNS)
    .from(monthlyReports)
    .innerJoin(schools, eq(monthlyReports.schoolId, schools.id))
    .orderBy(
      desc(monthlyReports.targetYear),
      desc(monthlyReports.targetMonth),
      asc(schools.name),
      asc(monthlyReports.id),
    );
}

/**
 * 月次レポート履歴 1 件を id で取得する。RLS で不可視 (他校 / 不存在) なら `undefined`。
 *
 * `WHERE id` は対象特定の条件であってテナント境界ではない (越権は RLS が弾く、上記参照)。DL Route
 * Handler が PDF を GCS から読む前に、保存 path (`pdfStoragePath`) と対象校 (`schoolId`、監査用) を
 * これで解決する。
 */
export async function getMonthlyReport(
  db: Selectable,
  id: string,
): Promise<MonthlyReportListItem | undefined> {
  const [row] = await db
    .select(LIST_COLUMNS)
    .from(monthlyReports)
    .innerJoin(schools, eq(monthlyReports.schoolId, schools.id))
    .where(eq(monthlyReports.id, id))
    .limit(1);
  return row;
}
