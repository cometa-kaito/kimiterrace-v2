import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { listSensorDevices } from "../../src/queries/sensor-presence.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F13 (#391 / #408, ADR-020): センサー管理画面の読み取り層 listSensorDevices を実 PG (RLS 込み) で検証する。
 *
 * 観点: (1) **テナント分離** — 自校のセンサーのみ返し別校は漏れない (CLAUDE.md ルール2)、(2) 最終検知
 * (lastSeenAt) が当該デバイスの presence イベント (`payload->>'device_mac'` = 正規化 MAC) の最新
 * occurred_at を取り、別デバイス/別校のイベントを混ぜない、(3) 撤去済 (decommissioned_at 有) も一覧し
 * 稼働中→撤去済の順、(4) 一度も検知が無いデバイスは lastSeenAt=null、(5) 空コンテキストは
 * deny-by-default で 0 件。
 *
 * device_mac はグローバル UNIQUE のため他テストと衝突しない値を使う。occurred_at / payload は DB 側で
 * 構築する ([[pg-date-bind-enum-insert]])。DATABASE_URL 未設定ならローカルは skip、CI (実 PG16) で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("F13 listSensorDevices (センサー一覧 read、最終検知 + RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxA = () => ({ schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ schoolId: fx.schoolB, role: "school_admin" as const });

  // 区切り付き表記で登録 → 正規化形 (大文字・区切り無し) は webhook の payload device_mac と一致する。
  const MAC_A_ACTIVE = "AA:BB:CC:DD:EE:11";
  const MAC_A_ACTIVE_NORM = "AABBCCDDEE11";
  const MAC_A_DECOMM = "AA:BB:CC:DD:EE:12";
  const MAC_B_ACTIVE = "AA:BB:CC:DD:EE:13";
  const MAC_B_ACTIVE_NORM = "AABBCCDDEE13";

  // presence イベントを「指定デバイス (正規化 MAC) の N 時間前検知」として投入する。occurred_at / payload は
  // DB 側で構築 ([[pg-date-bind-enum-insert]])。
  async function seedPresence(schoolId: string, macNorm: string, hoursAgo: number): Promise<void> {
    await raw`
      INSERT INTO events (school_id, type, occurred_at, payload)
      VALUES (
        ${schoolId}, 'presence',
        now() - make_interval(hours => ${hoursAgo}::int),
        jsonb_build_object('device_mac', ${macNorm}::text)
      )
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    // 各校にデバイスを登録 (owner 接続 = RLS バイパス)。A: 稼働 1 + 撤去済 1、B: 稼働 1。
    await raw`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, ${MAC_A_ACTIVE}, '1-A 教室前')
    `;
    await raw`
      INSERT INTO sensor_devices (school_id, device_mac, location_label, decommissioned_at)
      VALUES (${fx.schoolA}, ${MAC_A_DECOMM}, '旧 体育館入口', now() - make_interval(days => 3))
    `;
    await raw`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolB}, ${MAC_B_ACTIVE}, '職員室前')
    `;
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM events`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("テナント分離: 自校のセンサーのみ返し別校は漏れない (RLS)", async () => {
    const a = await withTenantContext(db, ctxA(), (tx) => listSensorDevices(tx), APP);
    expect(a.map((s) => s.deviceMac).sort()).toEqual([MAC_A_ACTIVE, MAC_A_DECOMM].sort());

    const b = await withTenantContext(db, ctxB(), (tx) => listSensorDevices(tx), APP);
    expect(b.map((s) => s.deviceMac)).toEqual([MAC_B_ACTIVE]);
  });

  it("並び順: 稼働中 (decommissioned_at NULL) を先頭、その後撤去済", async () => {
    const a = await withTenantContext(db, ctxA(), (tx) => listSensorDevices(tx), APP);
    expect(a).toHaveLength(2);
    // 稼働中が先頭、撤去済が後
    expect(a[0].deviceMac).toBe(MAC_A_ACTIVE);
    expect(a[0].decommissionedAt).toBeNull();
    expect(a[1].deviceMac).toBe(MAC_A_DECOMM);
    expect(a[1].decommissionedAt).not.toBeNull();
  });

  it("最終検知: 当該デバイスの presence 最新 occurred_at を返す (別校/別デバイスは混ざらない)", async () => {
    // A の稼働デバイスに 5h 前と 2h 前 → 最新 = 2h 前。
    await seedPresence(fx.schoolA, MAC_A_ACTIVE_NORM, 5);
    await seedPresence(fx.schoolA, MAC_A_ACTIVE_NORM, 2);
    // B のデバイスに 1h 前 (より新しい) → A の集計に漏れてはならない。
    await seedPresence(fx.schoolB, MAC_B_ACTIVE_NORM, 1);

    const a = await withTenantContext(db, ctxA(), (tx) => listSensorDevices(tx), APP);
    const active = a.find((s) => s.deviceMac === MAC_A_ACTIVE);
    const lastSeen = active?.lastSeenAt ?? null;
    expect(lastSeen).not.toBeNull();
    // 最新は 2h 前 (5h 前ではない)。約 2h 前であることを許容幅つきで確認。
    if (lastSeen !== null) {
      const ageMs = Date.now() - new Date(lastSeen).getTime();
      expect(ageMs).toBeGreaterThan(1.5 * 3_600_000);
      expect(ageMs).toBeLessThan(3 * 3_600_000);
    }

    // 検知の無い撤去済デバイスは null。
    const decomm = a.find((s) => s.deviceMac === MAC_A_DECOMM);
    expect(decomm?.lastSeenAt).toBeNull();
  });

  it("検知が一度も無いデバイスは lastSeenAt=null", async () => {
    const a = await withTenantContext(db, ctxA(), (tx) => listSensorDevices(tx), APP);
    expect(a.every((s) => s.lastSeenAt === null)).toBe(true);
  });

  it("deny-by-default: 空コンテキストは 0 件", async () => {
    const rows = await withTenantContext(db, {}, (tx) => listSensorDevices(tx), APP);
    expect(rows).toEqual([]);
  });
});
