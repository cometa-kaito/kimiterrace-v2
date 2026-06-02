import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { classBelongsToTenant } from "../../src/queries/magic-links.js";
import {
  createSensorDevice,
  getOwnSensorDevice,
  updateSensorDevice,
} from "../../src/queries/sensor-devices-status.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F13 (#391, ADR-020): 来場検知センサーの **登録 / 編集** mutation の RLS テナント分離 + 監査 +
 * device_mac グローバル一意衝突を実 PG で検証する (#485/#486 が defer した mutation スライス)。
 *
 * 検証:
 *  - register: 自校 context で INSERT 成功 (自校行に着地)。他校 school_id 直書きは WITH CHECK 拒否。
 *  - edit: 自校行は UPDATE 成功 (updated_at 進行 + updated_by 設定 = 監査整合)。**他校行は 0 行 UPDATE**
 *    (= not_found 相当) で、BYPASSRLS sanity で他校行が**改変されていない**ことを確認 (cross-tenant deny)。
 *  - device_mac グローバル一意衝突: 既登録 MAC (自校/他校) の register は 23505 で拒否。他校の MAC を
 *    register しても他校行は無傷 (BYPASSRLS sanity)。
 *
 * **非 vacuous**: ドメイン関数は superuser 接続を `appRole: 'kimiterrace_app'` で降格させ RLS を実際に
 * 効かせる (`withTenantContext` 経由)。`sql` (BYPASSRLS) はシード/検証専用、`db` (降格) はドメイン関数用。
 * timestamps は DB 側 (mutation 関数内 `new Date()` / RETURNING) で進め、外部時計に依存しない。
 * device_mac/UUID 定数は他テスト (`AA:BB:...`) と衝突しない `5C:CF:...` ブロックを使う (共有単一 fork DB)。
 *
 * すべて実 PG (DATABASE_URL) でのみ走り、未設定ならスキップ (ADR-012)。
 */
describeOrSkip("RLS: F13 sensor_devices mutations (#391)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // 他テストと衝突しない MAC ブロック (5C:CF:...)。canonicalizeMac は upper・区切り無しだが、
  // 本クエリ層は正規化しない (Server Action が正規化する) ため、保存値そのものを使う。
  const MAC_B_EXISTING = "5C:CF:7F:AA:00:B1"; // school B に事前登録するセンサー (衝突/越境検証用)
  const MAC_A_NEW = "5C:CF:7F:AA:00:A1"; // school A が新規登録する MAC
  let classAId: string;
  let classBId: string;
  let sensorBId: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // school A / B にクラスを 1 つずつ (class_id 紐付け + cross-tenant 検証用)。
    const [ca] = await sql<{ id: string }[]>`
      INSERT INTO classes (school_id, academic_year, name, grade)
      VALUES (${fx.schoolA}, 2026, '1-A', 1) RETURNING id
    `;
    const [cb] = await sql<{ id: string }[]>`
      INSERT INTO classes (school_id, academic_year, name, grade)
      VALUES (${fx.schoolB}, 2026, '2-B', 2) RETURNING id
    `;
    classAId = ca.id;
    classBId = cb.id;
    // school B に既存センサーを 1 台 (BYPASSRLS シード)。location_label は固定値で改変検出に使う。
    const [sb] = await sql<{ id: string }[]>`
      INSERT INTO sensor_devices (school_id, device_mac, location_label)
      VALUES (${fx.schoolB}, ${MAC_B_EXISTING}, 'B校 職員室前') RETURNING id
    `;
    sensorBId = sb.id;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("register: school A context で自校に INSERT 成功 (自校行に着地)", async () => {
    const { id } = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) =>
        createSensorDevice(tx, {
          schoolId: fx.schoolA,
          deviceMac: MAC_A_NEW,
          locationLabel: "A校 1-A 前",
          classId: classAId,
          actorUserId: fx.userA,
        }),
      APP,
    );
    expect(id).toBeTruthy();
    // BYPASSRLS sanity: 着地先が school A・指定値で入っている。
    const rows = await sql<
      { school_id: string; device_mac: string; class_id: string; created_by: string }[]
    >`
      SELECT school_id, device_mac, class_id, created_by FROM sensor_devices WHERE id = ${id}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].school_id).toBe(fx.schoolA);
    expect(rows[0].device_mac).toBe(MAC_A_NEW);
    expect(rows[0].class_id).toBe(classAId);
    expect(rows[0].created_by).toBe(fx.userA);
  });

  it("register: 他校 school_id を直書きすると WITH CHECK で拒否 (越境登録不可)", async () => {
    await expect(
      withTenantContext(
        db,
        { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
        (tx) =>
          createSensorDevice(tx, {
            // actor は A だが school_id に B を入れて越境を試みる → tenant_isolation WITH CHECK 拒否。
            schoolId: fx.schoolB,
            deviceMac: "5C:CF:7F:AA:00:C9",
            locationLabel: null,
            classId: null,
            actorUserId: fx.userA,
          }),
        APP,
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("device_mac グローバル一意衝突: 他校で登録済みの MAC は register 拒否 (23505) + 他校行は無傷", async () => {
    const before = await sql<{ school_id: string; location_label: string }[]>`
      SELECT school_id, location_label FROM sensor_devices WHERE device_mac = ${MAC_B_EXISTING}
    `;
    expect(before[0].school_id).toBe(fx.schoolB);

    let code: string | undefined;
    try {
      await withTenantContext(
        db,
        { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
        (tx) =>
          createSensorDevice(tx, {
            schoolId: fx.schoolA,
            deviceMac: MAC_B_EXISTING, // 他校が使用中の MAC を自校に登録しようとする
            locationLabel: "A校が奪おうとする",
            classId: null,
            actorUserId: fx.userA,
          }),
        APP,
      );
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("23505"); // unique_violation (ux_sensor_devices_device_mac)

    // 他校行は school_id も location_label も変わっていない (越境情報を奪っていない)。
    const after = await sql<{ school_id: string; location_label: string }[]>`
      SELECT school_id, location_label FROM sensor_devices WHERE device_mac = ${MAC_B_EXISTING}
    `;
    expect(after.length).toBe(1);
    expect(after[0].school_id).toBe(fx.schoolB);
    expect(after[0].location_label).toBe("B校 職員室前");
  });

  it("edit: 自校行は UPDATE 成功 + updated_at 進行 + updated_by 設定 (監査整合)", async () => {
    // arrange: school A に編集対象を 1 台 (BYPASSRLS シード、created_at は過去にする)。
    const [s] = await sql<{ id: string }[]>`
      INSERT INTO sensor_devices (school_id, device_mac, location_label, created_by, updated_by, created_at, updated_at)
      VALUES (${fx.schoolA}, '5C:CF:7F:AA:00:A2', '旧ラベル', ${fx.userA}, ${fx.userA},
              now() - make_interval(days => 3), now() - make_interval(days => 3))
      RETURNING id
    `;
    const targetId = s.id;
    const beforeRow = await sql<{ updated_at: string }[]>`
      SELECT updated_at FROM sensor_devices WHERE id = ${targetId}
    `;
    const beforeUpdatedAt = new Date(beforeRow[0].updated_at).getTime();

    const result = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) =>
        updateSensorDevice(
          tx,
          targetId,
          { locationLabel: "新ラベル", classId: classAId },
          fx.userA,
        ),
      APP,
    );
    expect(result).toEqual({ updated: true, id: targetId });

    // BYPASSRLS sanity: 値が更新され、updated_at が前進、updated_by が設定されている。
    const after = await sql<
      { location_label: string; class_id: string; updated_at: string; updated_by: string }[]
    >`
      SELECT location_label, class_id, updated_at, updated_by FROM sensor_devices WHERE id = ${targetId}
    `;
    expect(after[0].location_label).toBe("新ラベル");
    expect(after[0].class_id).toBe(classAId);
    expect(after[0].updated_by).toBe(fx.userA);
    expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(beforeUpdatedAt);
  });

  it("edit: 他校行 (school B) は school A context では 0 行 UPDATE (not_found 相当) + 他校行は無傷", async () => {
    const result = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) =>
        updateSensorDevice(
          tx,
          sensorBId, // 他校 (B) のセンサー id を A context で更新しようとする
          { locationLabel: "A校が改竄を試みる", classId: null },
          fx.userA,
        ),
      APP,
    );
    // RLS の tenant_isolation で B 行が不可視 → 0 行 UPDATE → updated:false (= not_found 写像)。
    expect(result).toEqual({ updated: false });

    // BYPASSRLS sanity: B 校行の location_label は元のまま (cross-tenant 改変が起きていない)。
    const after = await sql<{ location_label: string }[]>`
      SELECT location_label FROM sensor_devices WHERE id = ${sensorBId}
    `;
    expect(after[0].location_label).toBe("B校 職員室前");
  });

  it("getOwnSensorDevice: 他校 (B) のセンサーは school A context では不可視 (null)", async () => {
    const row = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      (tx) => getOwnSensorDevice(tx, sensorBId),
      APP,
    );
    expect(row).toBeNull();
  });

  it("逐次サニティ: school B context では自校行 (sensorBId) が getOwnSensorDevice で可視", async () => {
    const row = await withTenantContext(
      db,
      { schoolId: fx.schoolB, role: "school_admin", userId: fx.userB },
      (tx) => getOwnSensorDevice(tx, sensorBId),
      APP,
    );
    expect(row).not.toBeNull();
    expect(row?.schoolId).toBe(fx.schoolB);
  });

  it("cross-tenant class: A context では自校 classAId は可視・他校 classBId は不可視 (Action の事前検証 seam)", async () => {
    // Server Action は class_id 紐付け前に classBelongsToTenant で自校可視性を確認し、他校クラスへの
    // 「ねじれ結線」を弾く。その seam を実 PG で直接検証する (非 vacuous: A は true / B は false)。
    const [aVisible, bVisible] = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin", userId: fx.userA },
      async (tx) => [
        await classBelongsToTenant(tx, classAId),
        await classBelongsToTenant(tx, classBId),
      ],
      APP,
    );
    expect(aVisible).toBe(true);
    expect(bVisible).toBe(false);
  });
});
