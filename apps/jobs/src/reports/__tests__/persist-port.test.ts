import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F09 (#430): `createPgReportPersistPort` の配線ユニットテスト。
 *
 * 本ラッパの責務は「校スコープの RLS context (school_admin + school_id) を張って `insertMonthlyReport` へ
 * 委譲する」ことだけ。実 SQL / 実 RLS テナント分離は packages/db 側が担うため、ここでは @kimiterrace/db を
 * mock し「context の張り方」「降格ロール」「委譲先・引数」を pin する（GCP/PG 不要、ADR-012）。
 * `createPgEmbeddingPort` のテストと同じ構成。
 */

const { withTenantContext, insertMonthlyReport } = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  insertMonthlyReport: vi.fn(),
}));

vi.mock("@kimiterrace/db", () => ({ withTenantContext, insertMonthlyReport }));

import { createPgReportPersistPort } from "../persist-port.js";

const TX = Symbol("tx");
const DB = Symbol("db") as never;

const SUMMARY = {
  year: 2026,
  month: 6,
  totals: { view: 1, tap: 0, ask: 0 },
  ranking: [],
  activeDays: 1,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  withTenantContext.mockImplementation(
    async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown, _opts: unknown) => fn(TX),
  );
  insertMonthlyReport.mockResolvedValue({ id: "report-1" });
});

describe("createPgReportPersistPort", () => {
  it("record: school_admin + school_id の RLS context で insertMonthlyReport に委譲する（ルール2）", async () => {
    const port = createPgReportPersistPort({
      db: DB,
      schoolId: "school-A",
      appRole: "kimiterrace_app",
    });

    const res = await port.record({
      schoolId: "school-A",
      year: 2026,
      month: 6,
      storagePath: "reports/2026/06/school-A.pdf",
      pdfSizeBytes: 1234,
      metricsSnapshot: { summary: SUMMARY, adReach: [] },
    });

    expect(res).toEqual({ id: "report-1" });
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    const [db, ctx, , opts] = withTenantContext.mock.calls.at(0) ?? [];
    expect(db).toBe(DB);
    // system_admin ではなく school_admin に降格して RLS を実際に効かせる。
    expect(ctx).toEqual({ schoolId: "school-A", role: "school_admin" });
    expect(opts).toEqual({ appRole: "kimiterrace_app" });
    // INSERT 値は Drizzle 列名へ写像される（pdf_storage_path 等）。監査列はクエリ層が null 埋め。
    expect(insertMonthlyReport).toHaveBeenCalledWith(TX, {
      schoolId: "school-A",
      targetYear: 2026,
      targetMonth: 6,
      pdfStoragePath: "reports/2026/06/school-A.pdf",
      pdfSizeBytes: 1234,
      metricsSnapshot: { summary: SUMMARY, adReach: [] },
    });
  });

  it("appRole 未指定なら options は空（本番 kimiterrace_app 接続を想定し SET LOCAL ROLE しない）", async () => {
    const port = createPgReportPersistPort({ db: DB, schoolId: "school-B" });

    await port.record({
      schoolId: "school-B",
      year: 2026,
      month: 5,
      storagePath: "reports/2026/05/school-B.pdf",
      pdfSizeBytes: 1,
      metricsSnapshot: { summary: SUMMARY, adReach: [] },
    });

    const [, , , opts] = withTenantContext.mock.calls.at(0) ?? [];
    expect(opts).toEqual({});
  });
});
