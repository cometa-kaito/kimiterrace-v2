import { sql } from "drizzle-orm";
import { date, index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { advertisers } from "./advertisers.js";
import { schools } from "./schools.js";

/**
 * F09: 月次レポート metadata。
 *
 * **テナント分離テーブル**（`school_id` 必須、RLS 対象）。CRM 横断テーブル群とは異なり、
 * 月次レポート自体は学校ごとに閉じた集計成果物のためテナントスコープで管理する。
 *
 * - PDF 実体は Cloud Storage に保存し、ここは metadata（`pdf_gcs_path`）のみ保持。
 * - `report_month` は月初日 (YYYY-MM-01) で正規化（同月内重複は service 層で抑止）。
 * - `advertiser_id` は広告主向け個別レポート。学校向け汎用レポートは null。
 * - `status` は draft / sent。送付済を after-the-fact で書き換えないため、`sent_at` も保持。
 *
 * 関連: F09 (docs/requirements/functional/F09-monthly-report.md), ADR-019
 */
export const monthlyReports = pgTable(
  "monthly_reports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    // 広告主向けレポートのみ設定。学校向け汎用レポートは null。
    advertiserId: uuid("advertiser_id").references(() => advertisers.id, {
      onDelete: "set null",
    }),
    // 対象月（月初日で正規化、例: 2026-05-01）
    reportMonth: date("report_month").notNull(),
    // 例: "gs://kimiterrace-reports/2026-05/<uuid>.pdf"
    pdfGcsPath: varchar("pdf_gcs_path", { length: 512 }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().default(sql`now()`),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // draft / sent（将来拡張余地のため enum 化せず varchar）
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    ...auditColumns,
  },
  (t) => ({
    ixSchool: index("ix_monthly_reports_school_id").on(t.schoolId),
    ixSchoolMonth: index("ix_monthly_reports_school_month").on(t.schoolId, t.reportMonth),
    ixAdvertiser: index("ix_monthly_reports_advertiser_id").on(t.advertiserId),
  }),
);
