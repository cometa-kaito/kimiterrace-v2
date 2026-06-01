import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "../../src/client.js";
import { recordPresenceEvent } from "../../src/queries/sensor-presence.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F13 (#408, ADR-020): SwitchBot Webhook presence 書込み `recordPresenceEvent` の実 PG 結合テスト。
 *
 * セキュリティの核心を実 PG で pin する:
 *  - **cross-tenant 解決は BYPASSRLS 不使用**（`kimiterrace_app` ロール + system_admin context）。
 *  - 解決校の events にのみ書かれ、他校テナントには漏れない（RLS tenant_isolation）。
 *  - 未登録 / decommissioned MAC は計上しない。
 *  - 再送（同 device_mac + occurred_at）は二重計上しない（冪等）。
 *  - 監査は actor=null（システム）で 1 件残る（ルール1 / NFR04）。
 *  - 登録 MAC の区切り表記ゆれを正規化して解決する。
 */
describeOrSkip("RLS: F13 recordPresenceEvent (#408)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  const T = 1_700_000_000_000; // epoch ms（固定）
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    // school A: 稼働中デバイス（区切り付きで登録 = 表記ゆれ正規化の検証用）。
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, 'AA:BB:CC:DD:EE:01', '1-A 教室前')
    `;
    // school B: decommissioned デバイス（計上対象外の検証用）。
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, decommissioned_at)
      VALUES (${fx.schoolB}, 'AABBCCDDEE99', now())
    `;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  /** 指定校テナント context（非 BYPASSRLS）で presence events 件数を読む。 */
  async function countPresenceAs(schoolId: string): Promise<number> {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const rows = await tx<{ c: string }[]>`
        SELECT count(*)::text AS c FROM events WHERE type = 'presence'
      `;
      return Number(rows[0].c);
    });
  }

  it("正常 MAC → 解決校(A)に presence を書込み、他校(B)からは見えない（テナント分離）", async () => {
    const r = await recordPresenceEvent(
      db,
      {
        deviceMac: "AABBCCDDEE01",
        detectionState: "DETECTED",
        timeOfSampleMs: T,
        eventVersion: "1",
      },
      APP,
    );
    expect(r.status).toBe("recorded");
    if (r.status === "recorded") expect(r.schoolId).toBe(fx.schoolA);
    expect(await countPresenceAs(fx.schoolA)).toBe(1);
    expect(await countPresenceAs(fx.schoolB)).toBe(0);
  });

  it("登録が区切り付き(AA:BB:..)でも canonical 入力(AABB..)で解決する（正規化）", async () => {
    const r = await recordPresenceEvent(
      db,
      {
        deviceMac: "AABBCCDDEE01",
        detectionState: "DETECTED",
        timeOfSampleMs: T,
        eventVersion: null,
      },
      APP,
    );
    expect(r.status).toBe("recorded");
  });

  it("未登録 MAC は計上しない（unknown_device、events 0 件）", async () => {
    const r = await recordPresenceEvent(
      db,
      {
        deviceMac: "FFFFFFFFFFFF",
        detectionState: "DETECTED",
        timeOfSampleMs: T,
        eventVersion: null,
      },
      APP,
    );
    expect(r.status).toBe("unknown_device");
    expect(await countPresenceAs(fx.schoolA)).toBe(0);
    expect(await countPresenceAs(fx.schoolB)).toBe(0);
  });

  it("decommissioned デバイスは計上しない（unknown_device）", async () => {
    const r = await recordPresenceEvent(
      db,
      {
        deviceMac: "AABBCCDDEE99",
        detectionState: "DETECTED",
        timeOfSampleMs: T,
        eventVersion: null,
      },
      APP,
    );
    expect(r.status).toBe("unknown_device");
    expect(await countPresenceAs(fx.schoolB)).toBe(0);
  });

  it("再送（同 device_mac + occurred_at）は二重計上しない（冪等）", async () => {
    const input = {
      deviceMac: "AABBCCDDEE01",
      detectionState: "DETECTED",
      timeOfSampleMs: T,
      eventVersion: null,
    };
    const first = await recordPresenceEvent(db, input, APP);
    const second = await recordPresenceEvent(db, input, APP);
    expect(first.status).toBe("recorded");
    expect(second.status).toBe("duplicate");
    expect(await countPresenceAs(fx.schoolA)).toBe(1);
  });

  it("監査は actor=null（システム）で events insert が 1 件残る（ルール1 / NFR04）", async () => {
    await recordPresenceEvent(
      db,
      {
        deviceMac: "AABBCCDDEE01",
        detectionState: "DETECTED",
        timeOfSampleMs: T,
        eventVersion: null,
      },
      APP,
    );
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      return await tx<{ actor_user_id: string | null; school_id: string; operation: string }[]>`
        SELECT actor_user_id, school_id, operation FROM audit_log WHERE table_name = 'events'
      `;
    });
    expect(rows.length).toBe(1);
    expect(rows[0].actor_user_id).toBe(null);
    expect(rows[0].school_id).toBe(fx.schoolA);
    expect(rows[0].operation).toBe("insert");
  });
});
