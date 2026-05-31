import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * monthly_reports の cross-tenant RLS 許可/拒否テスト (ルール2 穴埋め、Refs #59 #266、脅威 I-01)。
 *
 * monthly_reports は **テナント分離テーブル** (school_id) で、月次レポート metadata + メトリクス
 * スナップショット + AI 効果コメントを保持する (F09)。policy は他テナント表と同じ 2 枚:
 * - `tenant_isolation` (migration 0002): FOR ALL、USING + WITH CHECK とも
 *   `school_id = NULLIF(current_setting('app.current_school_id', true), '')::uuid`。
 * - `system_admin_full_access` (migration 0002): `app.current_user_role = 'system_admin'` で全校横断。
 *
 * SELECT / INSERT(WITH CHECK) / UPDATE / DELETE の各経路で、自校のみ可・他校不可・context 未設定で
 * deny-by-default・system_admin のみ cross-tenant 可、を実 PG で固定する。DATABASE_URL 未設定なら skip。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/** metrics_snapshot (jsonb notNull) 用の最小スナップショット。 */
function snapshot(views: number): string {
  return JSON.stringify({ views });
}

describeOrSkip("RLS monthly_reports (テナント分離 + system_admin 横断)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // school A / B に月次レポートを 1 件ずつ (BYPASSRLS 接続)。(school_id, year, month) は unique。
    await sql`
      INSERT INTO monthly_reports
        (school_id, target_year, target_month, pdf_storage_path, pdf_size_bytes, metrics_snapshot)
      VALUES
        (${fx.schoolA}, 2026, 5, 'gs://reports/a/2026-05.pdf', 1024, ${snapshot(100)}::jsonb)
    `;
    await sql`
      INSERT INTO monthly_reports
        (school_id, target_year, target_month, pdf_storage_path, pdf_size_bytes, metrics_snapshot)
      VALUES
        (${fx.schoolB}, 2026, 5, 'gs://reports/b/2026-05.pdf', 2048, ${snapshot(200)}::jsonb)
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("school_id = A → 自校レポートのみ可視 (他校は見えない)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ school_id: string; pdf_storage_path: string }[]>`
        SELECT school_id, pdf_storage_path FROM monthly_reports
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
      expect(rows[0].pdf_storage_path).toBe("gs://reports/a/2026-05.pdf");
    });
  });

  it("school_id = B → 自校レポートのみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ school_id: string }[]>`SELECT school_id FROM monthly_reports`;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolB);
    });
  });

  it("school_id 未設定 + role 未設定 → 全件拒否 (deny-by-default, 0 件)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ school_id: string }[]>`SELECT school_id FROM monthly_reports`;
      expect(rows.length).toBe(0);
    });
  });

  it("system_admin → 全校のレポートが見える (cross-tenant read)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      // school_id 未設定でも system_admin は全件可視。
      const rows = await tx<{ school_id: string }[]>`
        SELECT school_id FROM monthly_reports ORDER BY pdf_size_bytes
      `;
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.school_id)).toEqual([fx.schoolA, fx.schoolB]);
    });
  });

  it("WITH CHECK 正: A context で school_id=A の INSERT は通る", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const res = await tx`
        INSERT INTO monthly_reports
          (school_id, target_year, target_month, pdf_storage_path, pdf_size_bytes, metrics_snapshot)
        VALUES
          (${fx.schoolA}, 2026, 7, 'gs://reports/a/2026-07.pdf', 512, ${snapshot(50)}::jsonb)
      `;
      expect(res.count).toBe(1);
    });
    // 後続テストの件数前提を汚さないよう BYPASSRLS で除去。
    await sql`DELETE FROM monthly_reports WHERE pdf_storage_path = 'gs://reports/a/2026-07.pdf'`;
  });

  it("WITH CHECK 負: A context で school_id=B の INSERT は拒否 (cross-tenant 書込封じ)", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO monthly_reports
            (school_id, target_year, target_month, pdf_storage_path, pdf_size_bytes, metrics_snapshot)
          VALUES
            (${fx.schoolB}, 2026, 9, 'gs://reports/b/forge.pdf', 1, ${snapshot(1)}::jsonb)
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("UPDATE: A context で他校 (B) レポートは更新不可 (silent 0-row)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const res = await tx`
        UPDATE monthly_reports SET ai_commentary = 'hijack' WHERE school_id = ${fx.schoolB}
      `;
      expect(res.count).toBe(0);
    });
    // 実際に変わっていないことを BYPASSRLS で確認。
    const after = await sql<{ ai_commentary: string | null }[]>`
      SELECT ai_commentary FROM monthly_reports WHERE school_id = ${fx.schoolB}
    `;
    expect(after[0]?.ai_commentary).toBeNull();
  });

  it("DELETE: A context で他校 (B) レポートは削除不可 (silent 0-row)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const res = await tx`DELETE FROM monthly_reports WHERE school_id = ${fx.schoolB}`;
      expect(res.count).toBe(0);
    });
    const remain = await sql<{ id: string }[]>`
      SELECT id FROM monthly_reports WHERE school_id = ${fx.schoolB}
    `;
    expect(remain.length).toBe(1);
  });

  it("system_admin → 他校 (B) レポートを cross-tenant UPDATE 可", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const res = await tx`
        UPDATE monthly_reports SET ai_commentary = 'sysadmin-note' WHERE school_id = ${fx.schoolB}
      `;
      expect(res.count).toBe(1);
    });
  });
});
