import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  type AllSensorDeviceStatus,
  listAllSensorStatuses,
} from "../../src/queries/sensor-devices-status.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F13 (#391, ADR-020): system_admin **全校横断** センサー状態 `listAllSensorStatuses` の実 PG RLS テスト。
 *
 * `listSensorDeviceStatuses` (自校版) に対する**全校版**。所属校名を併せて返す。観点:
 * (1) **system_admin context は全校のセンサー**を返す (`system_admin_full_access`、cross-tenant)、
 * (2) 各行に**所属校名 (schoolName)** が解決される、
 * (3) **テナント分離 / 多層防御** — school_admin context で呼んでも RLS が自校のみに絞り**越境しない**、
 * (4) 空コンテキストは deny-by-default、
 * (5) ヘルス判定 (healthy/quiet/dead/never) は自校版と同じ DB now() 基準で正しい、
 * (6) 射影に PII を含めない (件数・校名・設置場所・検知時刻のみ)。
 *
 * 接続は非 BYPASSRLS の `kimiterrace_app` に降格 (`withTenantContext` の appRole) して RLS を
 * **実際に効かせる** (さもないと vacuous)。シードはテーブル所有者接続 (BYPASSRLS) で行う。
 * presence は **DB 側 `now() - make_interval(...)`** で投入し JS Date を timestamptz に bind しない。
 * payload は `${JSON.stringify(...)}::jsonb` で投入する。
 */
describeOrSkip("RLS: F13 listAllSensorStatuses (全校横断 + 所属校名、#391)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;

  // device_mac は登録時の表記 (コロン区切り)。presence payload は webhook 正規形 (大文字・区切り無し)。
  const MAC_A_HEALTHY = "AA:BB:CC:DD:EE:01"; // school A: 直近 1h → healthy
  const MAC_A_DEAD = "AA:BB:CC:DD:EE:02"; // school A: 10 日前 → dead
  const MAC_B_QUIET = "AA:BB:CC:DD:EE:03"; // school B: 3 日前 → quiet
  const MAC_B_NEVER = "AA:BB:CC:DD:EE:04"; // school B: 検知なし → never

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
        ${JSON.stringify({ source: "switchbot", device_mac: normMac(mac), detection_state: "DETECTED" })}::jsonb
      )
    `;
  }

  function macNorm(s: AllSensorDeviceStatus): string {
    return s.deviceMac.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  }

  function byMac(rows: AllSensorDeviceStatus[], fullMac: string): AllSensorDeviceStatus {
    const norm = normMac(fullMac);
    const row = rows.find((r) => macNorm(r) === norm);
    if (!row) throw new Error(`row for ${fullMac} not found`);
    return row;
  }

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    // school A: 2 デバイス (healthy / dead)。school B: 2 デバイス (quiet / never)。計 2 校・4 台。
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, ${MAC_A_HEALTHY}, '1-A 教室前')
    `;
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolA}, ${MAC_A_DEAD}, '体育館入口')
    `;
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolB}, ${MAC_B_QUIET}, 'B校 2-B 教室前')
    `;
    await sql`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolB}, ${MAC_B_NEVER}, 'B校 昇降口')
    `;

    // 検知履歴 (DB now() 基準オフセット)。
    await seedPresence(fx.schoolA, MAC_A_HEALTHY, 1); // healthy
    await seedPresence(fx.schoolA, MAC_A_DEAD, 240); // dead (10 日前)
    await seedPresence(fx.schoolB, MAC_B_QUIET, 72); // quiet (3 日前)
    // MAC_B_NEVER: 投入しない (never)。
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  /** 指定テナント context (非 BYPASSRLS) で全校横断一覧を取得する。 */
  async function listAs(ctx: {
    schoolId?: string;
    role: "school_admin" | "system_admin";
  }): Promise<AllSensorDeviceStatus[]> {
    return await withTenantContext(
      db,
      { schoolId: ctx.schoolId, role: ctx.role },
      (tx) => listAllSensorStatuses(tx),
      APP,
    );
  }

  it("system_admin context は全校 (2 校) の全 4 センサーを返す (cross-tenant)", async () => {
    const rows = await listAs({ role: "system_admin" });
    expect(rows.length).toBe(4);
    // 2 校が両方とも見える。
    expect(new Set(rows.map((r) => r.schoolId))).toEqual(new Set([fx.schoolA, fx.schoolB]));
    // 4 台すべてのデバイスが含まれる。
    expect(new Set(rows.map((r) => macNorm(r)))).toEqual(
      new Set([MAC_A_HEALTHY, MAC_A_DEAD, MAC_B_QUIET, MAC_B_NEVER].map(normMac)),
    );
  });

  it("各行に所属校名 (schoolName) が解決される", async () => {
    const rows = await listAs({ role: "system_admin" });
    expect(byMac(rows, MAC_A_HEALTHY).schoolName).toBe("テスト高校 A");
    expect(byMac(rows, MAC_A_DEAD).schoolName).toBe("テスト高校 A");
    expect(byMac(rows, MAC_B_QUIET).schoolName).toBe("テスト高校 B");
    expect(byMac(rows, MAC_B_NEVER).schoolName).toBe("テスト高校 B");
  });

  it("並びは学校名昇順で学校単位に固まる (A 校 → B 校)", async () => {
    const rows = await listAs({ role: "system_admin" });
    // 学校名昇順なので A 校 2 台が先、B 校 2 台が後 (学校境界をまたいで混ざらない)。
    expect(rows[0].schoolId).toBe(fx.schoolA);
    expect(rows[1].schoolId).toBe(fx.schoolA);
    expect(rows[2].schoolId).toBe(fx.schoolB);
    expect(rows[3].schoolId).toBe(fx.schoolB);
  });

  it("ヘルス判定は DB now() 基準で正しい (healthy/dead/quiet/never)", async () => {
    const rows = await listAs({ role: "system_admin" });
    expect(byMac(rows, MAC_A_HEALTHY).status).toBe("healthy");
    expect(byMac(rows, MAC_A_DEAD).status).toBe("dead");
    expect(byMac(rows, MAC_B_QUIET).status).toBe("quiet");
    expect(byMac(rows, MAC_B_NEVER).status).toBe("never");
    expect(byMac(rows, MAC_B_NEVER).lastDetectedAt).toBeNull();
  });

  it("多層防御: school_admin (A 校) context で呼んでも RLS が A 校のみに絞り越境しない", async () => {
    const rows = await listAs({ schoolId: fx.schoolA, role: "school_admin" });
    // A 校の 2 台のみ。B 校の 2 台 (quiet / never) は一切見えない (cross-tenant deny)。
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.schoolId === fx.schoolA)).toBe(true);
    expect(rows.every((r) => r.schoolName === "テスト高校 A")).toBe(true);
    const macs = new Set(rows.map((r) => macNorm(r)));
    expect(macs).toEqual(new Set([MAC_A_HEALTHY, MAC_A_DEAD].map(normMac)));
    // B 校のセンサーは混ざらない (明示否定でテナント越境拒否を pin)。
    expect(macs.has(normMac(MAC_B_QUIET))).toBe(false);
    expect(macs.has(normMac(MAC_B_NEVER))).toBe(false);
  });

  it("空コンテキスト (role / school_id 無し) → deny-by-default で 0 件", async () => {
    const rows = await withTenantContext(db, {}, (tx) => listAllSensorStatuses(tx), APP);
    expect(rows.length).toBe(0);
  });

  it("射影は校名・設置場所・件数・検知時刻のみ — PII を含めない (ルール4)", async () => {
    const rows = await listAs({ role: "system_admin" });
    expect(rows.length).toBeGreaterThan(0);
    const expectedKeys = [
      "id",
      "schoolId",
      "schoolName",
      "deviceMac",
      "locationLabel",
      "classId",
      "className",
      "installedAt",
      "decommissionedAt",
      "lastDetectedAt",
      "detections24h",
      "status",
    ].sort();
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(expectedKeys);
    }
  });
});
