import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { listTvDevices, pollTvConfig } from "../../src/queries/tv-devices.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F15/F16 (ADR-022/ADR-023): TV デバイスレジストリ tv_devices の RLS テナント分離 +
 * device_id グローバル一意性 + ポーリング解決（pollTvConfig）の cross-tenant 解決を検証する。
 *
 * - tenant_isolation: 自校のみ可視、他テナント INSERT は WITH CHECK で拒否、context 未設定で 0 件
 * - system_admin_full_access: cross-tenant で全件可視
 * - device_id グローバル UNIQUE: 別テナントが同一 device_id を登録できない（ポーリング解決の一意性）
 * - listTvDevices: 自校のみ返る（RLS 委譲、ソフトデリート除外）
 * - pollTvConfig: device_id で cross-tenant 解決し last_seen_at を更新、未登録/ソフトデリートは unknown
 *
 * すべて実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。pollTvConfig / listTvDevices は
 * テスト superuser 接続を `appRole: 'kimiterrace_app'` で降格させ RLS を実際に効かせる（さもないと vacuous）。
 *
 * `sql`（BYPASSRLS スーパーユーザー）はシード/検証専用、`db`（同接続を appRole で降格）はドメイン関数用。
 */
describeOrSkip("RLS: F15/F16 tv_devices", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  const DEV_A = "11111111-1111-4111-8111-111111111111";
  const DEV_B = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校に TV 1 台ずつ（BYPASSRLS = テーブル所有者接続でシード）。
    await sql`
      INSERT INTO tv_devices (school_id, device_id, label, signage_url, target_mac, version)
      VALUES (${fx.schoolA}, ${DEV_A}, '電子工学科 1年', 'https://sig.example/?school=A', 'DC:A5:B3:C2:98:A1', 3)
    `;
    await sql`
      INSERT INTO tv_devices (school_id, device_id, label, signage_url, target_mac, version)
      VALUES (${fx.schoolB}, ${DEV_B}, '職員室', 'https://sig.example/?school=B', 'DC:A5:B3:C2:98:B2', 1)
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("school A context は A の TV のみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const rows = await tx<{ device_id: string; school_id: string }[]>`
        SELECT device_id, school_id FROM tv_devices
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
      expect(rows[0].device_id).toBe(DEV_A);
    });
  });

  it("school B context は B の TV のみ可視（別テナントは見えない）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const rows = await tx<{ device_id: string }[]>`SELECT device_id FROM tv_devices`;
      expect(rows.length).toBe(1);
      expect(rows[0].device_id).toBe(DEV_B);
    });
  });

  it("context 未設定 → 全件拒否（0 件、deny by default）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM tv_devices`;
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
          INSERT INTO tv_devices (school_id, device_id)
          VALUES (${fx.schoolB}, '99999999-9999-4999-8999-999999999999')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("system_admin は cross-tenant で全 TV が見える", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM tv_devices`;
      expect(rows.length).toBe(2);
    });
  });

  it("device_id はグローバル一意: 別テナントが同一 device_id を登録できない（ポーリング解決の一意性）", async () => {
    // system_admin（cross-tenant）でも、既存の DEV_A を school B 用に登録しようとすると
    // ux_tv_devices_device_id の UNIQUE 違反で拒否される。これにより device_id→school_id 解決が常に
    // 一意になり、A 校 TV へ B 校設定を配信するテナント越境を構造的に防ぐ。
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
        await tx`
          INSERT INTO tv_devices (school_id, device_id)
          VALUES (${fx.schoolB}, ${DEV_A})
        `;
      }),
    ).rejects.toThrow(/duplicate key|unique constraint|ux_tv_devices_device_id/i);
  });

  it("listTvDevices: school A context は A の TV のみ返る（RLS 委譲）", async () => {
    const rows = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin" },
      (tx) => listTvDevices(tx),
      APP,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].deviceId).toBe(DEV_A);
    expect(rows[0].label).toBe("電子工学科 1年");
  });

  it("listTvDevices: system_admin context は全 TV が返る（cross-tenant）", async () => {
    const rows = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => listTvDevices(tx),
      APP,
    );
    expect(rows.length).toBe(2);
  });

  it("pollTvConfig: device_id で cross-tenant 解決 + last_seen 更新（appRole 降格で RLS 実効）", async () => {
    const before = await sql<{ last_seen_at: string | null }[]>`
      SELECT last_seen_at FROM tv_devices WHERE device_id = ${DEV_A}
    `;
    expect(before[0].last_seen_at).toBeNull();

    const result = await pollTvConfig(db, { deviceId: DEV_A, lastKnownIp: "203.0.113.5" }, APP);
    expect(result.unknown).toBe(false);
    if (!result.unknown) {
      expect(result.version).toBe(3);
      expect(result.config.signageUrl).toBe("https://sig.example/?school=A");
      expect(result.config.deviceLabel).toBe("電子工学科 1年");
    }

    // 副作用: last_seen_at が now() で更新され、last_known_ip も記録される（BYPASSRLS 接続で検証）。
    const after = await sql<{ last_seen_at: string | null; last_known_ip: string | null }[]>`
      SELECT last_seen_at, last_known_ip FROM tv_devices WHERE device_id = ${DEV_A}
    `;
    expect(after[0].last_seen_at).not.toBeNull();
    expect(after[0].last_known_ip).toBe("203.0.113.5");
  });

  it("pollTvConfig: 未登録 device_id は unknown（last_seen を作らない）", async () => {
    const result = await pollTvConfig(
      db,
      { deviceId: "00000000-0000-4000-8000-000000000000", lastKnownIp: null },
      APP,
    );
    expect(result).toEqual({ unknown: true, version: 0 });
  });

  it("pollTvConfig: ソフトデリート済（deleted_at）は unknown 扱い", async () => {
    const DEV_DEL = "33333333-3333-4333-8333-333333333333";
    await sql`
      INSERT INTO tv_devices (school_id, device_id, label, deleted_at)
      VALUES (${fx.schoolA}, ${DEV_DEL}, '退役 TV', now())
    `;
    const result = await pollTvConfig(db, { deviceId: DEV_DEL, lastKnownIp: null }, APP);
    expect(result).toEqual({ unknown: true, version: 0 });
  });
});
