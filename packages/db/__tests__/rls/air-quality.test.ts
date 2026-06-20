import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "../../src/client.js";
import { getAirQualityByArea, upsertAirQuality } from "../../src/queries/air-quality.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * ADR-046: air_quality_index の RLS（公開参照マスタ特例）を実 PG で検証する（heat-alerts.test.ts の姉妹）。
 *
 * 検証の核（Reviewer 重点）:
 *   - **全ロール + 匿名サイネージが SELECT 可**（air_quality_index_read_all, USING (true)）。大気質・UV は公開・非 PII。
 *     ★ ADR-016 のサイネージ匿名コンテキスト（role 未設定 / school_id のみ or 無し）が確実に読めること。
 *   - **非 system は INSERT / UPDATE / DELETE 不可**（air_quality_index_write_system_*）。書込みは system に閉じる。
 *   - **system_admin（取得 Job 経路）は upsert 可**。(area_code, source, forecast_date) 競合で UPDATE（冪等な再取得）。
 *
 * 接続ロールは superuser だが、トランザクション内で `SET LOCAL ROLE kimiterrace_app` に降格して RLS を
 * 実際に効かせる（さもないと所有者バイパスで vacuous になる）。
 */
describeOrSkip("RLS: ADR-046 air_quality_index", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  const AREA = "210000"; // 岐阜県
  const DAY = "2026-07-15";
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    // air_quality_index は seedBaseFixture の TRUNCATE 対象外（school_id 非保持の cross-tenant 参照で
    // schools CASCADE に巻き込まれない）ため、テスト間で行が残らないよう明示クリアする。
    await sql.unsafe("TRUNCATE air_quality_index RESTART IDENTITY;");
    // 閲覧テスト用の固定行を owner 接続（RLS バイパス）で投入。
    await sql`
      INSERT INTO air_quality_index (area_code, area_name, source, forecast_date, pm25, pm25_band, raw)
      VALUES (${AREA}, '岐阜県', 'env_soramame', ${DAY}, 24, 'moderate', '{"pm25":24}'::jsonb)
    `;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // --- ★ SELECT 全開放（全ロール + 匿名） ---

  it("全テナントロール（school_admin/teacher/student/guardian）が SELECT できる", async () => {
    for (const role of ["school_admin", "teacher", "student", "guardian"] as const) {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_user_role', ${role}, true)`;
        const rows = await tx`SELECT id FROM air_quality_index WHERE area_code = ${AREA}`;
        expect(rows.length, `role=${role}`).toBe(1);
      });
    }
  });

  it("★ サイネージ匿名コンテキスト（role 未設定・school_id のみ）でも SELECT できる（ADR-016）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      // school_id のみ set、role / userId は set しない（匿名サイネージ = deny-by-default 接続）。
      // 大気質は cross-tenant 共有なので school_id に関係なく air_quality_index_read_all で読める。
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      const rows = await tx`SELECT id FROM air_quality_index WHERE area_code = ${AREA}`;
      expect(rows.length).toBe(1);
    });
  });

  it("context 完全無し（role も school_id も無し）でも SELECT できる（公開データ、USING true）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx`SELECT id FROM air_quality_index WHERE area_code = ${AREA}`;
      expect(rows.length).toBe(1);
    });
  });

  // --- ★ 書き込みは system のみ ---

  it("非 system（school_admin）は INSERT できない（air_quality_index_write_system_insert）", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', '00000000-0000-0000-0000-000000000001', true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO air_quality_index (area_code, source, forecast_date, pm25)
          VALUES ('999999', 'env_soramame', ${DAY}, 10)
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("匿名（role 無し）も INSERT できない（deny-by-default）", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`
          INSERT INTO air_quality_index (area_code, source, forecast_date, pm25)
          VALUES ('999999', 'env_soramame', ${DAY}, 10)
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("非 system（teacher）は UPDATE / DELETE できない（0 行 or 拒否、漏洩・改竄防止）", async () => {
    // UPDATE: air_quality_index_write_system_update の USING が false → 0 行（エラーにはならないが変更不可）。
    const updated = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      return tx`UPDATE air_quality_index SET pm25 = 99 WHERE area_code = ${AREA} RETURNING id`;
    });
    expect(updated.length).toBe(0);

    const deleted = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      return tx`DELETE FROM air_quality_index WHERE area_code = ${AREA} RETURNING id`;
    });
    expect(deleted.length).toBe(0);

    // owner 接続で 1 行が無傷であることを確認。
    await sql`RESET ROLE`;
    const survive = await sql`SELECT pm25 FROM air_quality_index WHERE area_code = ${AREA}`;
    expect(survive.length).toBe(1);
    expect(survive[0].pm25).toBe(24);
  });

  // --- ★ system_admin（取得 Job 経路）の upsert ---

  it("upsertAirQuality: system context で INSERT、競合キーで UPDATE（last-known-good 更新）", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    const NEW_AREA = "130000"; // 東京都（fixture に無い新規）
    try {
      const db = drizzle(client);
      // 1) 新規 INSERT（system context）。
      const id1 = await withTenantContext(
        db,
        { role: "system_admin" },
        (tx) =>
          upsertAirQuality(tx, {
            areaCode: NEW_AREA,
            areaName: "東京都",
            forecastDate: DAY,
            pm25: 18,
            pm25Band: "moderate",
            raw: { v: 1 },
          }),
        { appRole: "kimiterrace_app" },
      );
      expect(id1).toMatch(/^[0-9a-f-]{36}$/);

      // 2) 同一 (area_code, source, forecast_date) で再 upsert → UPDATE（同 id、値差し替え）。
      const id2 = await withTenantContext(
        db,
        { role: "system_admin" },
        (tx) =>
          upsertAirQuality(tx, {
            areaCode: NEW_AREA,
            forecastDate: DAY,
            pm25: 72,
            pm25Band: "hazardous",
            raw: { v: 2 },
          }),
        { appRole: "kimiterrace_app" },
      );
      expect(id2).toBe(id1); // upsert で行は増えない

      // owner 接続で結果検証（1 行・最新値・created/updated の監査整合）。
      await client.unsafe("RESET ROLE");
      const rows = await client<
        {
          pm25: number | null;
          pm25_band: string | null;
          created_by: string | null;
          updated_at: Date;
          created_at: Date;
        }[]
      >`SELECT pm25, pm25_band, created_by, created_at, updated_at FROM air_quality_index WHERE area_code = ${NEW_AREA}`;
      expect(rows.length).toBe(1);
      expect(rows[0].pm25).toBe(72);
      expect(rows[0].pm25_band).toBe("hazardous");
      expect(rows[0].created_by).toBeNull(); // システム書き込み（ルール1: システム作成は null）
      // ルール1: UPDATE で updated_at を明示更新（created_at 以降）。
      expect(new Date(rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[0].created_at).getTime(),
      );
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("getAirQualityByArea: 匿名サイネージ context で当日以降の最新 1 行を読む / 無い地域は null", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const found = await db.transaction(async (tx) => {
        // 匿名サイネージ context（role 無し）に降格。air_quality_index_read_all で読めることを実証。
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        return getAirQualityByArea(tx, AREA, DAY);
      });
      expect(found?.pm25).toBe(24);
      expect(found?.pm25Band).toBe("moderate");

      const missing = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        return getAirQualityByArea(tx, "999999", DAY);
      });
      expect(missing).toBeNull();
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });
});
