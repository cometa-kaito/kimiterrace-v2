import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { insertMonthlyReport } from "../../src/queries/monthly-reports-write.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F09 (#430): `insertMonthlyReport`（月次レポート生成履歴 upsert）を実 PG (RLS 込み) で検証する。
 *
 * 接続は DATABASE_URL の superuser (BYPASSRLS) なので、appRole で kimiterrace_app に降格してから RLS を
 * 効かせる（本番は最初から kimiterrace_app 接続）。raw (BYPASSRLS) は検証用 SELECT に使う。テーブルレベルの
 * cross-tenant policy 網羅は `monthly-reports.test.ts`、本ファイルは **クエリ関数の冪等 upsert と監査** を pin。
 */
describeOrSkip("F09 monthly_reports 生成履歴 upsert (#430, RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM monthly_reports`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  // school_admin 降格 context（自校のみ、RLS 強制、ルール2）。
  const ctxA = () => ({ schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ schoolId: fx.schoolB, role: "school_admin" as const });

  function values(schoolId: string, opts: { path: string; size: number; views: number }) {
    return {
      schoolId,
      targetYear: 2026,
      targetMonth: 6,
      pdfStoragePath: opts.path,
      pdfSizeBytes: opts.size,
      metricsSnapshot: { summary: { views: opts.views }, adReach: [] },
    };
  }

  it("school A context で INSERT し、path / サイズ / メトリクスを記録、監査列はシステム作成で null（ルール1）", async () => {
    const { id } = await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        insertMonthlyReport(
          tx,
          values(fx.schoolA, { path: "reports/2026/06/a.pdf", size: 1024, views: 100 }),
        ),
      APP,
    );
    expect(id).toBeTruthy();

    const [row] = await raw<
      {
        school_id: string;
        target_year: number;
        target_month: number;
        pdf_storage_path: string;
        pdf_size_bytes: number;
        metrics_snapshot: { summary: { views: number } };
        created_by: string | null;
        updated_by: string | null;
      }[]
    >`
      SELECT school_id, target_year, target_month, pdf_storage_path, pdf_size_bytes,
             metrics_snapshot, created_by, updated_by
      FROM monthly_reports WHERE id = ${id}
    `;
    expect(row.school_id).toBe(fx.schoolA);
    expect(row.target_year).toBe(2026);
    expect(row.target_month).toBe(6);
    expect(row.pdf_storage_path).toBe("reports/2026/06/a.pdf");
    expect(Number(row.pdf_size_bytes)).toBe(1024);
    expect(row.metrics_snapshot.summary.views).toBe(100);
    // システムバッチ生成なので actor は無い（auditColumns の「システム作成は null」規約、ルール1）。
    expect(row.created_by).toBeNull();
    expect(row.updated_by).toBeNull();
  });

  it("冪等: 同一 (school, year, month) の再実行は重複行を作らず path/サイズ/メトリクスを上書き（#430 設計判断）", async () => {
    const first = await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        insertMonthlyReport(
          tx,
          values(fx.schoolA, { path: "reports/2026/06/a.pdf", size: 1024, views: 100 }),
        ),
      APP,
    );
    // 同じ年月で再実行（path/サイズ/メトリクスが変わったとみなす）。
    const second = await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        insertMonthlyReport(
          tx,
          values(fx.schoolA, { path: "reports/2026/06/a.pdf", size: 2048, views: 250 }),
        ),
      APP,
    );

    // upsert なので行 id は同一（重複行を作らない）。
    expect(second.id).toBe(first.id);

    const rows = await raw<
      {
        id: string;
        pdf_size_bytes: number;
        metrics_snapshot: { summary: { views: number } };
        created_at: Date;
        updated_at: Date;
        generated_at: Date;
      }[]
    >`
      SELECT id, pdf_size_bytes, metrics_snapshot, created_at, updated_at, generated_at
      FROM monthly_reports WHERE school_id = ${fx.schoolA}
    `;
    expect(rows.length).toBe(1); // 重複行が無い（unique 制約 + onConflictDoUpdate）。
    expect(Number(rows[0].pdf_size_bytes)).toBe(2048); // 上書き済み。
    expect(rows[0].metrics_snapshot.summary.views).toBe(250);
    // ルール1: 再生成で updated_at を明示更新（作成時刻のまま残さない）。created_at は初回値を保つ。
    expect(rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(rows[0].created_at.getTime());
  });

  it("テナント分離 (write): B context で A の school_id を指定した upsert は WITH CHECK が弾く（ルール2）", async () => {
    await expect(
      withTenantContext(
        db,
        ctxB(),
        (tx) =>
          insertMonthlyReport(
            tx,
            values(fx.schoolA, { path: "reports/2026/06/forge.pdf", size: 1, views: 1 }),
          ),
        APP,
      ),
    ).rejects.toThrow();

    // 越境 INSERT は成立していない（A の行は増えていない）。
    const all = await raw`SELECT id FROM monthly_reports WHERE school_id = ${fx.schoolA}`;
    expect(all.length).toBe(0);
  });
});
