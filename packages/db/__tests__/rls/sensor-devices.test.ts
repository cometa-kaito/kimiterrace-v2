import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F13 (#391, ADR-020): 来場検知センサー登録テーブル sensor_devices の RLS テナント分離 +
 * webhook 解決の前提となる device_mac グローバル一意性を検証する。
 *
 * - tenant_isolation: 自校のみ可視、他テナント INSERT は WITH CHECK で拒否、context 未設定で 0 件
 * - system_admin_full_access: cross-tenant で全件可視
 * - device_mac グローバル UNIQUE: 別テナントが同一 MAC を登録できない
 *   （= webhook の device_mac→school_id 解決が一意。テナント越境ルーティング防止。schema コメント参照）
 */
describeOrSkip("RLS: F13 sensor_devices (#391)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  const MAC_A = "AA:BB:CC:DD:EE:01";
  const MAC_B = "AA:BB:CC:DD:EE:02";

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校にセンサー 1 台ずつ（BYPASSRLS = テーブル所有者接続でシード）
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, ${MAC_A}, '1-A 教室前')
    `;
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolB}, ${MAC_B}, '職員室前')
    `;
    // class_id 紐付け検証用にクラスを 1 件（school A）
    await sql`
      INSERT INTO classes (school_id, academic_year, name, grade)
      VALUES (${fx.schoolA}, 2026, '1-A', 1)
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("school A context は A のセンサーのみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ device_mac: string; school_id: string }[]>`
        SELECT device_mac, school_id FROM sensor_devices
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
      expect(rows[0].device_mac).toBe(MAC_A);
    });
  });

  it("school B context は B のセンサーのみ可視（別テナントは見えない）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;

      const rows = await tx<{ device_mac: string }[]>`SELECT device_mac FROM sensor_devices`;
      expect(rows.length).toBe(1);
      expect(rows[0].device_mac).toBe(MAC_B);
    });
  });

  it("context 未設定 → 全件拒否（0 件、deny by default）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM sensor_devices`;
      expect(rows.length).toBe(0);
    });
  });

  it("他テナント school_id で INSERT は WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO sensor_devices (school_id, device_mac)
          VALUES (${fx.schoolB}, 'AA:BB:CC:DD:EE:99')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("system_admin は cross-tenant で全センサーが見える", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      const rows = await tx<{ id: string }[]>`SELECT id FROM sensor_devices`;
      expect(rows.length).toBe(2);
    });
  });

  it("device_mac はグローバル一意: 別テナントが同一 MAC を登録できない（webhook 解決の一意性）", async () => {
    // system_admin（cross-tenant）でも、既存の MAC_A を school B 用に登録しようとすると
    // ux_sensor_devices_device_mac の UNIQUE 違反で拒否される。
    // これにより device_mac→school_id 解決が常に一意になり、テナント越境ルーティングを構造的に防ぐ。
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
        await tx`
          INSERT INTO sensor_devices (school_id, device_mac)
          VALUES (${fx.schoolB}, ${MAC_A})
        `;
      }),
    ).rejects.toThrow(/duplicate key|unique constraint|ux_sensor_devices_device_mac/i);
  });
});
