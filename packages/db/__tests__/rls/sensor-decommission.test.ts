import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { setSensorDecommissioned } from "../../src/queries/sensor-devices-status.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * 運営整理 §4 item5: センサーの **撤去 / 再稼働** (`setSensorDecommissioned`) の実 PG RLS テスト。
 *
 * 観点:
 *  - **system_admin context は任意校 (他校) のセンサーを撤去 / 再稼働できる** (`system_admin_full_access`、
 *    全校横断 = 運営の監視運用)。`decommissioned_at` が Date / null に切り替わる。
 *  - **school_admin context は自校センサーのみ** 撤去できる (`tenant_isolation`)。**他校行は 0 行 UPDATE**
 *    (= not_found 相当) で、BYPASSRLS sanity で他校行が**改変されていない**ことを確認 (cross-tenant deny)。
 *
 * 接続は非 BYPASSRLS の `kimiterrace_app` に降格 (`withTenantContext` の appRole) して RLS を実際に効かせる。
 * シード/検証は所有者接続 (BYPASSRLS) で行う。他テストと衝突しない MAC ブロック (5C:CF:7F:DC) を使う。
 * すべて実 PG (DATABASE_URL) でのみ走り、未設定ならスキップ (ADR-012)。
 */
describeOrSkip("RLS: setSensorDecommissioned 撤去/再稼働 (全校, 運営整理 §4)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const MAC_A = "5C:CF:7F:DC:00:A1";
  const MAC_B = "5C:CF:7F:DC:00:B1";
  let sensorAId: string;
  let sensorBId: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    const [sa] = await sql<{ id: string }[]>`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, ${MAC_A}, 'A校 撤去テスト') RETURNING id
    `;
    const [sb] = await sql<{ id: string }[]>`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolB}, ${MAC_B}, 'B校 撤去テスト') RETURNING id
    `;
    sensorAId = sa.id;
    sensorBId = sb.id;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  /** BYPASSRLS で対象の decommissioned_at を読む (改変検出用)。 */
  async function decommissionedAt(id: string): Promise<string | null> {
    const rows = await sql<{ decommissioned_at: string | null }[]>`
      SELECT decommissioned_at FROM sensor_devices WHERE id = ${id}
    `;
    return rows[0]?.decommissioned_at ?? null;
  }

  it("system_admin context は他校 (B校) センサーを撤去できる (全校・cross-tenant)", async () => {
    await sql`UPDATE sensor_devices SET decommissioned_at = NULL WHERE id = ${sensorBId}`;
    const result = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => setSensorDecommissioned(tx, sensorBId, new Date(), null),
      APP,
    );
    expect(result).toEqual({ updated: true, id: sensorBId });
    expect(await decommissionedAt(sensorBId)).not.toBeNull();
  });

  it("system_admin context は撤去済みセンサーを再稼働できる (decommissioned_at → null)", async () => {
    await sql`UPDATE sensor_devices SET decommissioned_at = now() WHERE id = ${sensorBId}`;
    const result = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => setSensorDecommissioned(tx, sensorBId, null, null),
      APP,
    );
    expect(result).toEqual({ updated: true, id: sensorBId });
    expect(await decommissionedAt(sensorBId)).toBeNull();
  });

  it("school_admin (A校) context は自校センサーを撤去できる", async () => {
    await sql`UPDATE sensor_devices SET decommissioned_at = NULL WHERE id = ${sensorAId}`;
    const result = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) => setSensorDecommissioned(tx, sensorAId, new Date(), fx.userA),
      APP,
    );
    expect(result).toEqual({ updated: true, id: sensorAId });
    expect(await decommissionedAt(sensorAId)).not.toBeNull();
    // 後始末: 稼働中に戻す。
    await sql`UPDATE sensor_devices SET decommissioned_at = NULL WHERE id = ${sensorAId}`;
  });

  it("school_admin (A校) context では他校 (B校) は 0 行 UPDATE (tenant_isolation deny) + 無傷", async () => {
    await sql`UPDATE sensor_devices SET decommissioned_at = NULL WHERE id = ${sensorBId}`;
    const result = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) => setSensorDecommissioned(tx, sensorBId, new Date(), fx.userA),
      APP,
    );
    expect(result).toEqual({ updated: false });
    // BYPASSRLS sanity: B 校行は撤去されていない (cross-tenant 改変なし)。
    expect(await decommissionedAt(sensorBId)).toBeNull();
  });
});
