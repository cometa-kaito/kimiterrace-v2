import {
  type AdReachByAd,
  type KimiterraceDb,
  type MonthlySchoolSummary,
  type TenantRole,
  insertMonthlyReport,
  withTenantContext,
} from "@kimiterrace/db";

/**
 * F09 (#45 / #430): 月次レポート生成履歴 (`monthly_reports`) 書き込みの実 PG / RLS アダプタ。
 *
 * `reports/run.ts` のドライバが「GCS 保存 → 履歴 INSERT」を結線する際に使う書き込みポート。`insertMonthlyReport`
 * (packages/db) を **school_admin に降格した** RLS context (school_id + role) を張った短いトランザクション内で
 * 呼ぶ (BYPASSRLS 不使用、ルール2)。`system_admin` を使うと `system_admin_full_access` policy が全校
 * PERMISSIVE に発火し越境するため、必ず school_admin で叩く (校列挙ドライバが system_admin で schools を引き、
 * 校ごとに本ポートを生成する: embedding バッチの `createPgEmbeddingPort` と同じ構成)。
 *
 * テスト容易性のため、ドライバは `ReportPersistPort` interface に依存する。本ラッパは RLS context の張り方だけを
 * 担い、ユニットテストでは配線を pin する (RLS 密結合 SQL 本体と実 PG テナント分離テストは packages/db 側)。
 */

/** GCS 保存後の生成履歴を 1 校 1 か月分だけ記録する最小ポート (実体は RLS context 内 upsert)。 */
export interface ReportPersistPort {
  /**
   * 月次レポート生成履歴を 1 行 upsert する。
   * @returns 記録した monthly_reports 行 id。
   */
  record(input: ReportPersistInput): Promise<{ id: string }>;
}

/**
 * 履歴 1 行分の入力。`metricsSnapshot` は生成時点のメトリクス即値を保存 (後方変更耐性、schema コメント参照)。
 */
export type ReportPersistInput = {
  /** 対象校 (RLS context の school_id と一致する必要がある、ルール2)。 */
  schoolId: string;
  /** 対象年 (西暦)。 */
  year: number;
  /** 対象月 (1-12)。 */
  month: number;
  /** GCS の保存 path (`buildReportObjectPath` の戻り値)。 */
  storagePath: string;
  /** 保存した PDF のバイト数。 */
  pdfSizeBytes: number;
  /** 生成時メトリクス即値 (学校別サマリー + 広告別到達)。jsonb で保存し過去レポートを後方再現可能にする。 */
  metricsSnapshot: { summary: MonthlySchoolSummary; adReach: AdReachByAd[] };
};

export type PgReportPersistPortConfig = {
  /** 非 BYPASSRLS ロールで接続した Drizzle クライアント (本番は `kimiterrace_app`)。 */
  db: KimiterraceDb;
  /** この校の school_id。RLS スコープを張る。 */
  schoolId: string;
  /**
   * BYPASSRLS な接続 (テスト superuser 等) をアプリロールへ降格する `SET LOCAL ROLE` 先。
   * 本番は最初から `kimiterrace_app` 接続のため未指定。
   */
  appRole?: string;
};

/** 1 ポートインスタンス = 1 校スコープ。`createPgEmbeddingPort` と同形の RLS ラッパ。 */
export function createPgReportPersistPort(config: PgReportPersistPortConfig): ReportPersistPort {
  const { db, schoolId, appRole } = config;
  // 校スコープの RLS context。system_admin ではなく school_admin で RLS を実際に効かせる (ルール2)。
  const ctx = { schoolId, role: "school_admin" satisfies TenantRole as TenantRole };
  const options = appRole !== undefined ? { appRole } : {};
  return {
    record(input) {
      return withTenantContext(
        db,
        ctx,
        (tx) =>
          insertMonthlyReport(tx, {
            schoolId: input.schoolId,
            targetYear: input.year,
            targetMonth: input.month,
            pdfStoragePath: input.storagePath,
            pdfSizeBytes: input.pdfSizeBytes,
            metricsSnapshot: input.metricsSnapshot,
          }),
        options,
      );
    },
  };
}
