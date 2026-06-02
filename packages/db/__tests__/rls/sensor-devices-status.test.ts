import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  type SensorDeviceStatus,
  listSensorDeviceStatuses,
} from "../../src/queries/sensor-devices-status.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F13 (#391, ADR-020): センサー管理/状態一覧 `listSensorDeviceStatuses` の実 PG 結合テスト。
 *
 * 2 つの不変条件を実 PG で pin する:
 *  1. **テナント分離 (ルール2)**: 自校 context は自校センサーのみ可視、他校 context は他校のみ、
 *     system_admin は全校横断。アプリ側 WHERE school_id は書かず、すべて RLS 委譲で成立する。
 *  2. **鮮度/ヘルス判定の正しさ**: presence イベントを **DB 側 `now() - make_interval(...)`** の
 *     既知オフセットで投入し (JS Date を timestamptz に bind しない)、healthy / quiet / dead /
 *     never の分類と直近検知時刻・24h 検知数が正しいことを確認する。時刻は DB の now() 基準。
 *
 * 接続は非 BYPASSRLS の `kimiterrace_app` に降格 (`withTenantContext` の appRole) して RLS を
 * 実際に効かせる (さもないと vacuous)。シードはテーブル所有者接続 (BYPASSRLS) で行う。
 */
describeOrSkip("RLS: F13 listSensorDeviceStatuses (#391)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;

  // device_mac は登録時の表記 (コロン区切り)。presence payload は webhook 正規形 (大文字・区切り無し)。
  const MAC_HEALTHY = "AA:BB:CC:DD:EE:01"; // 直近 1h に検知 → healthy
  const MAC_QUIET = "AA:BB:CC:DD:EE:02"; // 3 日前に検知 → quiet
  const MAC_DEAD = "AA:BB:CC:DD:EE:03"; // 10 日前に検知 → dead
  const MAC_NEVER = "AA:BB:CC:DD:EE:04"; // 検知なし → never
  const MAC_B = "AA:BB:CC:DD:EE:09"; // school B 用

  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  /** payload.device_mac の正規形 (大文字・区切り無し)。webhook 取り込みと同じ形に潰す。 */
  function normMac(mac: string): string {
    return mac.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  }

  /** presence イベントを DB now() からの時間オフセット (hours) で投入する (所有者接続)。 */
  async function seedPresence(schoolId: string, mac: string, hoursAgo: number): Promise<void> {
    await sql`
      INSERT INTO events (school_id, type, occurred_at, payload)
      VALUES (
        ${schoolId},
        'presence',
        now() - make_interval(hours => ${hoursAgo}::int),
        ${sql.json({ source: "switchbot", device_mac: normMac(mac), detection_state: "DETECTED" })}
      )
    `;
  }

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    // school A: クラス 1 件 (class 紐付け検証用)。
    const [cls] = await sql<{ id: string }[]>`
      INSERT INTO classes (school_id, academic_year, name, grade)
      VALUES (${fx.schoolA}, 2026, '1-A', 1)
      RETURNING id
    `;
    // school A: 4 デバイス (各ヘルス状態 1 つずつ)。healthy のみクラス紐付け。
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label, class_id)
      VALUES (${fx.schoolA}, ${MAC_HEALTHY}, '1-A 教室前', ${cls.id})
    `;
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, ${MAC_QUIET}, '2-B 教室前')
    `;
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, ${MAC_DEAD}, '体育館入口')
    `;
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, ${MAC_NEVER}, '職員室前')
    `;
    // school B: 1 デバイス (テナント分離検証用)。
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolB}, ${MAC_B}, 'B校 昇降口')
    `;

    // 検知履歴 (DB now() 基準オフセット)。
    // healthy: 直近 1h に 2 件 + 12h 前に 1 件 (= 24h 窓に 3 件)。
    await seedPresence(fx.schoolA, MAC_HEALTHY, 1);
    await seedPresence(fx.schoolA, MAC_HEALTHY, 1);
    await seedPresence(fx.schoolA, MAC_HEALTHY, 12);
    // healthy 用に 30h 前 (24h 窓の外) を 1 件 → 24h 検知数に含めない検証。
    await seedPresence(fx.schoolA, MAC_HEALTHY, 30);
    // quiet: 3 日前 (72h) に 1 件 (24h 超だが 7 日以内)。
    await seedPresence(fx.schoolA, MAC_QUIET, 72);
    // dead: 10 日前 (240h) に 1 件 (7 日超)。
    await seedPresence(fx.schoolA, MAC_DEAD, 240);
    // MAC_NEVER: 投入しない (never)。
    // school B: 直近 2h に 1 件 (B context での可視性検証用)。
    await seedPresence(fx.schoolB, MAC_B, 2);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  /** 指定テナント context (非 BYPASSRLS) で一覧を取得する。 */
  async function listAs(ctx: {
    schoolId?: string;
    role: "school_admin" | "system_admin";
  }): Promise<SensorDeviceStatus[]> {
    return await withTenantContext(
      db,
      { schoolId: ctx.schoolId, role: ctx.role },
      (tx) => listSensorDeviceStatuses(tx),
      APP,
    );
  }

  function byMacTail(rows: SensorDeviceStatus[], fullMac: string): SensorDeviceStatus {
    const norm = fullMac.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    const row = rows.find((r) => r.deviceMac.replace(/[^0-9A-Za-z]/g, "").toUpperCase() === norm);
    if (!row) throw new Error(`row for ${fullMac} not found`);
    return row;
  }

  it("school A context は A の 4 センサーのみ可視 (テナント分離、他校は見えない)", async () => {
    const rows = await listAs({ schoolId: fx.schoolA, role: "school_admin" });
    expect(rows.length).toBe(4);
    // B 校のセンサーは混ざらない。
    expect(
      rows.some((r) => r.deviceMac.replace(/[^0-9A-Za-z]/g, "").toUpperCase() === "AABBCCDDEE09"),
    ).toBe(false);
  });

  it("school B context は B の 1 センサーのみ可視 (別テナント不可視)", async () => {
    const rows = await listAs({ schoolId: fx.schoolB, role: "school_admin" });
    expect(rows.length).toBe(1);
    expect(rows[0].deviceMac.replace(/[^0-9A-Za-z]/g, "").toUpperCase()).toBe("AABBCCDDEE09");
    // B の検知 (2h 前) は healthy。
    expect(rows[0].status).toBe("healthy");
  });

  it("context 未設定 (role のみ無し) → deny-by-default で 0 件", async () => {
    // schoolId も role も張らない (空 context) → tenant_isolation も full_access も不成立 → 0 件。
    const rows = await withTenantContext(db, {}, (tx) => listSensorDeviceStatuses(tx), APP);
    expect(rows.length).toBe(0);
  });

  it("system_admin context は全校横断で全 5 センサーが見える", async () => {
    const rows = await listAs({ role: "system_admin" });
    expect(rows.length).toBe(5);
  });

  it("ヘルス判定: healthy / quiet / dead / never が DB now() 基準で正しく分類される", async () => {
    const rows = await listAs({ schoolId: fx.schoolA, role: "school_admin" });
    expect(byMacTail(rows, MAC_HEALTHY).status).toBe("healthy");
    expect(byMacTail(rows, MAC_QUIET).status).toBe("quiet");
    expect(byMacTail(rows, MAC_DEAD).status).toBe("dead");
    expect(byMacTail(rows, MAC_NEVER).status).toBe("never");
  });

  it("直近 24h 検知数は 24h 窓内のみを数える (30h 前の 1 件は除外)", async () => {
    const rows = await listAs({ schoolId: fx.schoolA, role: "school_admin" });
    // healthy: 1h×2 + 12h×1 = 3 件 (30h 前は窓外)。
    expect(byMacTail(rows, MAC_HEALTHY).detections24h).toBe(3);
    // quiet (72h 前) は 24h 窓に入らない → 0。
    expect(byMacTail(rows, MAC_QUIET).detections24h).toBe(0);
    // never は検知なし → 0。
    expect(byMacTail(rows, MAC_NEVER).detections24h).toBe(0);
  });

  it("直近検知時刻: 検知ありは最新時刻、検知なしは null", async () => {
    const rows = await listAs({ schoolId: fx.schoolA, role: "school_admin" });
    const healthy = byMacTail(rows, MAC_HEALTHY);
    const never = byMacTail(rows, MAC_NEVER);
    expect(healthy.lastDetectedAt).toBeInstanceOf(Date);
    // 最新検知 (1h 前) は now() の 2h 以内に収まる (緩い境界で timing 非依存)。
    const ageMs = Date.now() - (healthy.lastDetectedAt as Date).getTime();
    expect(ageMs).toBeLessThan(2 * 60 * 60 * 1000);
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(never.lastDetectedAt).toBeNull();
  });

  it("クラス名は紐付けがあれば解決、無ければ null (LEFT JOIN、自校 classes も RLS 委譲)", async () => {
    const rows = await listAs({ schoolId: fx.schoolA, role: "school_admin" });
    expect(byMacTail(rows, MAC_HEALTHY).className).toBe("1-A");
    expect(byMacTail(rows, MAC_QUIET).className).toBeNull();
  });
});
