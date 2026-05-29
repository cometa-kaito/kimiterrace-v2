import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schools } from "./schools.js";

/**
 * F09: 月次レポート metadata。
 *
 * **テナント分離 (school_id あり) / RLS 対象**。本 Part C1 の中で唯一の RLS 対象テーブル
 * （RLS policy 自体は Part C2 で追加）。
 *
 * - PDF 本体は Cloud Storage に保管し、本表は path のみ持つ（最大数 MB の PDF を 10 年保存する
 *   のは Cloud SQL に不向きなため、ADR-018 で Storage 退避を選択）。
 * - `metrics_snapshot` は生成時点のメトリクス即値を jsonb で保存（後方変更耐性。生成後にスキーマが
 *   変わっても過去レポートは復元可能）。
 * - `ai_commentary` は F08 連携で AI が生成した効果コメント（任意）。
 * - 月次 1 件制約は `(school_id, target_year, target_month)` unique で表現。
 *
 * 関連: ADR-018 (CRM 独自設計), F09 (docs/requirements/functional/F09-monthly-report.md)
 */
export const monthlyReports = pgTable(
  "monthly_reports",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "restrict" }),
    targetYear: integer("target_year").notNull(),
    targetMonth: integer("target_month").notNull(),
    pdfStoragePath: varchar("pdf_storage_path", { length: 500 }).notNull(),
    pdfSizeBytes: integer("pdf_size_bytes").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`now()`),
    metricsSnapshot: jsonb("metrics_snapshot").notNull(),
    aiCommentary: text("ai_commentary"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    ...auditColumns,
  },
  (t) => ({
    ixSchool: index("ix_monthly_reports_school_id").on(t.schoolId),
    ixYearMonth: index("ix_monthly_reports_year_month").on(t.targetYear, t.targetMonth),
    uxSchoolYearMonth: uniqueIndex("ux_monthly_reports_school_year_month").on(
      t.schoolId,
      t.targetYear,
      t.targetMonth,
    ),
  }),
);
