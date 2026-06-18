import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  createTvDevice,
  getTvDeviceConfig,
  listTvDevices,
  pollTvConfig,
  softDeleteTvDevice,
} from "../../src/queries/tv-devices.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F15 §4.2 (ADR-022 / ADR-019): TV デバイスのソフトデリート `softDeleteTvDevice` を検証する。
 *
 * 観点:
 *  - **不可視化**: 削除後は read 経路（listTvDevices / getTvDeviceConfig / pollTvConfig）から消える。
 *  - **冪等**: 二重削除は 0 行（undefined）で deleted_at を上書きしない。
 *  - **RLS テナント分離（ルール2）**: school_admin は自校のみ削除可。別校デバイスへの削除は 0 行（不可視）。
 *
 * 注: `device_id` はグローバル UNIQUE（`tv_device_commands`/`tv_device_downtime` の FK 参照先）のままなので、
 * ソフト削除後も同一 device_id の再登録は不可（撤去端末は別 device_id で再プロビジョン）。よって「再利用」テストは持たない。
 *
 * 実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。ドメイン関数はテスト superuser 接続を
 * `appRole: 'kimiterrace_app'` で降格させ RLS を実際に効かせる（さもないと vacuous）。`sql`（BYPASSRLS）は
 * シード/検証専用。
 */
describeOrSkip("RLS: F15 softDeleteTvDevice", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  function input(deviceId: string, schoolId: string) {
    return {
      deviceId,
      schoolId,
      label: "進路指導室前",
      targetMac: null,
      signageUrl: "https://sig.example/?x=1",
      webhookUrl: null,
      scheduleJson: null,
      monitoringEnabled: true,
      notes: null,
      createdBy: null,
    };
  }

  /** system_admin context で schoolA に 1 台登録し、行 PK を返す。 */
  async function seedDevice(deviceId: string, schoolId: string): Promise<string> {
    const ref = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => createTvDevice(tx, input(deviceId, schoolId)),
      APP,
    );
    return ref.id;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("削除後は read 経路（list / get / poll）から不可視になる", async () => {
    const dev = "bbbbbbb1-1111-4111-8111-111111111111";
    const rowId = await seedDevice(dev, fx.schoolA);

    const ref = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => softDeleteTvDevice(tx, { id: rowId, actorUserId: null }),
      APP,
    );
    expect(ref?.id).toBe(rowId);
    expect(ref?.schoolId).toBe(fx.schoolA);
    expect(ref?.deviceId).toBe(dev);

    // 一覧から消える。
    const list = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => listTvDevices(tx),
      APP,
    );
    expect(list.some((d) => d.id === rowId)).toBe(false);

    // 編集読み込みは undefined（退役 → not_found）。
    const cfg = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => getTvDeviceConfig(tx, rowId),
      APP,
    );
    expect(cfg).toBeUndefined();

    // ポーリングは未登録扱い（設定配信も死活計上もしない）。
    const poll = await pollTvConfig(db, { deviceId: dev, lastKnownIp: null }, APP);
    expect(poll.unknown).toBe(true);

    // 物理行は残る（履歴保全）。deleted_at が立っている。
    const raw = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM tv_devices WHERE id = ${rowId}
    `;
    expect(raw.length).toBe(1);
    expect(raw[0].deleted_at).not.toBeNull();
  });

  it("二重削除は 0 行（undefined）で deleted_at を上書きしない（冪等）", async () => {
    const dev = "bbbbbbb2-2222-4222-8222-222222222222";
    const rowId = await seedDevice(dev, fx.schoolA);

    const first = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => softDeleteTvDevice(tx, { id: rowId, actorUserId: null }),
      APP,
    );
    expect(first?.id).toBe(rowId);
    const firstDeletedAt = await sql<{ deleted_at: Date }[]>`
      SELECT deleted_at FROM tv_devices WHERE id = ${rowId}
    `;

    const second = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => softDeleteTvDevice(tx, { id: rowId, actorUserId: null }),
      APP,
    );
    expect(second).toBeUndefined();

    // deleted_at は最初の削除時刻のまま（上書きされない）。
    const afterDeletedAt = await sql<{ deleted_at: Date }[]>`
      SELECT deleted_at FROM tv_devices WHERE id = ${rowId}
    `;
    expect(afterDeletedAt[0].deleted_at.getTime()).toBe(firstDeletedAt[0].deleted_at.getTime());
  });

  it("school_admin は別校デバイスを削除できない（RLS で 0 行・行は稼働中のまま）", async () => {
    const dev = "bbbbbbb3-3333-4333-8333-333333333333";
    const rowId = await seedDevice(dev, fx.schoolA);

    // schoolB の admin context では schoolA のデバイスは不可視 → 0 行 → undefined。
    const ref = await withTenantContext(
      db,
      { role: "school_admin", schoolId: fx.schoolB, userId: fx.userB },
      (tx) => softDeleteTvDevice(tx, { id: rowId, actorUserId: fx.userB }),
      APP,
    );
    expect(ref).toBeUndefined();

    // 行は稼働中のまま（deleted_at IS NULL）。
    const raw = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM tv_devices WHERE id = ${rowId}
    `;
    expect(raw[0].deleted_at).toBeNull();
  });
});
