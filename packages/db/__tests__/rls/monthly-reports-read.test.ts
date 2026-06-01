import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getMonthlyReport, listMonthlyReports } from "../../src/queries/monthly-reports-read.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F09 (#430): `listMonthlyReports` / `getMonthlyReport` を実 PG (RLS 込み) で検証する。
 *
 * monthly_reports には 2 policy (0002_rls_policies.sql): `system_admin_full_access` (全校) /
 * `tenant_isolation` (自校のみ)。read 関数は WHERE に role/school を書かず RLS に委ねるため、可視範囲が
 * context で正しく変わること (system_admin=全校横断 / テナント=自校のみ / deny-by-default) を固定する。
 * 関数そのものを `withTenantContext` 経由で実行し、射影 / 並び / 校名結合を突き合わせる。
 * DATABASE_URL 未設定なら skip (ADR-012)。
 */
function snapshot(views: number): string {
  return JSON.stringify({ views });
}

describeOrSkip(
  "#430 listMonthlyReports / getMonthlyReport (system_admin=全校 / テナント=自校)",
  () => {
    // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
    const { sql: raw, db } = createDbClient(url!);
    const APP = { appRole: "kimiterrace_app" };
    let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
    let reportA = "";
    let reportB = "";

    beforeAll(async () => {
      fx = await seedBaseFixture(raw);
      // school A / B に月次レポートを 1 件ずつ (BYPASSRLS 接続)。(school_id, year, month) は unique。
      const [a] = await raw<{ id: string }[]>`
      INSERT INTO monthly_reports
        (school_id, target_year, target_month, pdf_storage_path, pdf_size_bytes, metrics_snapshot)
      VALUES
        (${fx.schoolA}, 2026, 5, 'reports/2026/05/a.pdf', 1024, ${snapshot(100)}::jsonb)
      RETURNING id
    `;
      const [b] = await raw<{ id: string }[]>`
      INSERT INTO monthly_reports
        (school_id, target_year, target_month, pdf_storage_path, pdf_size_bytes, metrics_snapshot)
      VALUES
        (${fx.schoolB}, 2026, 5, 'reports/2026/05/b.pdf', 2048, ${snapshot(200)}::jsonb)
      RETURNING id
    `;
      reportA = a.id;
      reportB = b.id;
    });

    beforeEach(async () => {
      await raw`RESET ROLE`;
    });

    afterAll(async () => {
      await raw.end({ timeout: 5 });
    });

    it("system_admin → 全校のレポートが新しい月順で見える (cross-tenant read)", async () => {
      const rows = await withTenantContext(
        db,
        { userId: fx.sysAdmin, role: "system_admin" },
        (tx) => listMonthlyReports(tx),
        APP,
      );
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(reportA);
      expect(ids).toContain(reportB);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it("射影は軽量 (校名 + DL メタのみ、metrics_snapshot / ai_commentary 非含)", async () => {
      const rows = await withTenantContext(
        db,
        { userId: fx.sysAdmin, role: "system_admin" },
        (tx) => listMonthlyReports(tx),
        APP,
      );
      expect(Object.keys(rows[0]).sort()).toEqual([
        "generatedAt",
        "id",
        "pdfSizeBytes",
        "pdfStoragePath",
        "schoolId",
        "schoolName",
        "targetMonth",
        "targetYear",
      ]);
    });

    it("校名が schools 結合で解決される", async () => {
      const rows = await withTenantContext(
        db,
        { userId: fx.sysAdmin, role: "system_admin" },
        (tx) => listMonthlyReports(tx),
        APP,
      );
      const a = rows.find((r) => r.id === reportA);
      expect(a?.schoolName).toBe("テスト高校 A");
    });

    it("school_admin (A) → 自校レポートのみ可視、他校 (B) は不可視", async () => {
      const rows = await withTenantContext(
        db,
        { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
        (tx) => listMonthlyReports(tx),
        APP,
      );
      expect(rows.map((r) => r.id)).toEqual([reportA]);
    });

    it("school context 未設定のテナント role → 0 件 (deny-by-default)", async () => {
      const rows = await withTenantContext(
        db,
        { userId: fx.userA, role: "school_admin" },
        (tx) => listMonthlyReports(tx),
        APP,
      );
      expect(rows.length).toBe(0);
    });

    it("getMonthlyReport: system_admin は他校 (B) の単件も解決できる", async () => {
      const row = await withTenantContext(
        db,
        { userId: fx.sysAdmin, role: "system_admin" },
        (tx) => getMonthlyReport(tx, reportB),
        APP,
      );
      expect(row?.id).toBe(reportB);
      expect(row?.schoolId).toBe(fx.schoolB);
      expect(row?.pdfStoragePath).toBe("reports/2026/05/b.pdf");
    });

    it("getMonthlyReport: school_admin (A) が他校 (B) id を渡すと undefined (RLS で不可視)", async () => {
      const row = await withTenantContext(
        db,
        { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
        (tx) => getMonthlyReport(tx, reportB),
        APP,
      );
      expect(row).toBeUndefined();
    });

    it("getMonthlyReport: school_admin (A) は自校 (A) 単件を解決できる", async () => {
      const row = await withTenantContext(
        db,
        { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
        (tx) => getMonthlyReport(tx, reportA),
        APP,
      );
      expect(row?.id).toBe(reportA);
    });
  },
);
