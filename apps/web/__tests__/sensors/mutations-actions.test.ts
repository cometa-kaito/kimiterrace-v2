import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F13 (#391, ADR-020): センサー登録 / 編集 Server Action の配線テスト。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は `importOriginal` で実体を保ちつつ、
 * DB 触りのヘルパ (`classBelongsToTenant` / `createSensorDevice` / `updateSensorDevice` /
 * `getOwnSensorDevice`) を差し替えて cross-tenant / conflict / not_found 経路を検証する。
 * `withSession` は callback を fake tx で実行する。
 *
 * 重点: 認可 (SENSOR_WRITE_ROLES=school_admin / system_admin、teacher は弾く)、入力検証で DB に到達しない
 * こと、device_mac 一意衝突 (23505) → conflict 写像で他校情報を漏らさない、edit 0 行 → not_found、
 * cross-tenant classId 拒否、ADR-041 D3 の system_admin 特定校代行 (targetSchoolId 配線 + userRef=null FK 回避
 * + withSession の tenantScoped 降格)。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const classBelongsToTenantMock = vi.fn();
const createSensorDeviceMock = vi.fn();
const updateSensorDeviceMock = vi.fn();
const getOwnSensorDeviceMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    classBelongsToTenant: (...a: unknown[]) => classBelongsToTenantMock(...a),
    createSensorDevice: (...a: unknown[]) => createSensorDeviceMock(...a),
    updateSensorDevice: (...a: unknown[]) => updateSensorDeviceMock(...a),
    getOwnSensorDevice: (...a: unknown[]) => getOwnSensorDeviceMock(...a),
  };
});

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  createSensorDeviceAction,
  updateSensorDeviceAction,
} from "../../lib/sensors/mutations-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const SENSOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SENSOR_ID = "99999999-9999-4999-8999-999999999999";
const CLASS_ID = "44444444-4444-4444-8444-444444444444";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const admin = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };
const SYSADMIN_UID = "55555555-5555-4555-8555-555555555555";
const TARGET_SCHOOL_ID = "66666666-6666-4666-8666-666666666666";
const sysAdmin = { uid: SYSADMIN_UID, role: "system_admin" as const, schoolId: null };

const VALID_CREATE = {
  deviceMac: "AA:BB:CC:DD:EE:FF",
  locationLabel: "1-A 教室前",
  classId: CLASS_ID,
};

/** insert/update のチェーンと audit insert を満たす fake tx。 */
function fakeTx() {
  const chain = {
    values: () => Promise.resolve(undefined),
  };
  return { insert: () => chain };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(admin);
  classBelongsToTenantMock.mockResolvedValue(true);
  createSensorDeviceMock.mockResolvedValue({ id: "new-sensor-1" });
  updateSensorDeviceMock.mockResolvedValue({ updated: true, id: SENSOR_ID });
  getOwnSensorDeviceMock.mockResolvedValue({
    id: SENSOR_ID,
    locationLabel: "旧ラベル",
    classId: null,
  });
  // callback を fake tx で実行 (cross-tenant / not_found / conflict 経路を通すため)。
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), admin))) as typeof withSession);
});

/** withSession 呼び出しの options (2 引数目) を取り出す (tenantScoped / schoolId 配線の検証)。 */
function lastWithSessionOptions():
  | { tenantScoped?: boolean; schoolId?: string | null }
  | undefined {
  const call = withSessionMock.mock.calls.at(-1);
  return call?.[1] as { tenantScoped?: boolean; schoolId?: string | null } | undefined;
}

describe("createSensorDeviceAction", () => {
  it("不正な MAC は invalid を返し、認可も走らせない", async () => {
    const res = await createSensorDeviceAction({ ...VALID_CREATE, deviceMac: "zzz" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("locationLabel が 120 文字超は DB に到達せず invalid", async () => {
    const res = await createSensorDeviceAction({
      ...VALID_CREATE,
      locationLabel: "あ".repeat(121),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("SENSOR_WRITE_ROLES (school_admin / system_admin) で認可する (teacher は含まない)", async () => {
    await createSensorDeviceAction(VALID_CREATE);
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("schoolId 無し (テナント未選択 school_admin) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "school_admin", schoolId: null });
    const res = await createSensorDeviceAction(VALID_CREATE);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("system_admin で targetSchoolId 未指定は forbidden、DB に到達しない (越境防止)", async () => {
    requireRoleMock.mockResolvedValue(sysAdmin);
    const res = await createSensorDeviceAction(VALID_CREATE);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("school_admin: 自校に降格スコープ (tenantScoped + schoolId=自校) で書く", async () => {
    await createSensorDeviceAction(VALID_CREATE);
    expect(lastWithSessionOptions()).toEqual({ tenantScoped: true, schoolId: SCHOOL_ID });
  });

  it("system_admin: 対象校代行 — userRef=null (FK 回避) + 対象校に降格スコープ", async () => {
    requireRoleMock.mockResolvedValue(sysAdmin);
    const res = await createSensorDeviceAction(VALID_CREATE, TARGET_SCHOOL_ID);
    expect(res).toEqual({ ok: true, data: { id: "new-sensor-1" } });
    // 対象校に tenantScoped 降格して書く (system_admin_full_access の全校発火を止める)。
    expect(lastWithSessionOptions()).toEqual({ tenantScoped: true, schoolId: TARGET_SCHOOL_ID });
    const createInput = createSensorDeviceMock.mock.calls[0]?.[1];
    expect(createInput).toMatchObject({
      schoolId: TARGET_SCHOOL_ID,
      // created_by/updated_by は users FK。system_admin は users 行が無いため null。
      actorUserId: null,
    });
  });

  it("cross-tenant: 自校で不可視なクラスは invalid (CrossTenantClassError 写像)", async () => {
    classBelongsToTenantMock.mockResolvedValue(false);
    const res = await createSensorDeviceAction(VALID_CREATE);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(createSensorDeviceMock).not.toHaveBeenCalled();
  });

  it("device_mac グローバル一意衝突 (23505) は conflict 写像 (他校情報を漏らさない)", async () => {
    // 本番同形: Drizzle は pg エラーを wrap し SQLSTATE を cause.code へ移す（top-level だけ見ると取りこぼし 500 化）。
    createSensorDeviceMock.mockRejectedValue(
      Object.assign(new Error("Failed query: insert into sensor_devices"), {
        cause: Object.assign(new Error("duplicate key value"), { code: "23505" }),
      }),
    );
    const res = await createSensorDeviceAction(VALID_CREATE);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    // 他校がどの学校か等は message に出さない (固定文言)。
    if (!res.ok) {
      expect(res.error.message).not.toMatch(/school|学校[A-Z]|テスト高校/);
    }
  });

  it("正常系: 作成して id を返す (MAC は正規化済みで渡る)", async () => {
    const res = await createSensorDeviceAction(VALID_CREATE);
    expect(res).toEqual({ ok: true, data: { id: "new-sensor-1" } });
    expect(createSensorDeviceMock).toHaveBeenCalledTimes(1);
    // canonicalizeMac: 大文字・区切り無し。第 2 引数 (input) を検証する。
    const createInput = createSensorDeviceMock.mock.calls[0]?.[1];
    expect(createInput).toMatchObject({
      schoolId: SCHOOL_ID,
      deviceMac: "AABBCCDDEEFF",
      actorUserId: USER_ID,
    });
  });

  it("classId 未指定 (空文字) でも登録でき、class 検証はスキップされる", async () => {
    const res = await createSensorDeviceAction({ deviceMac: "AABBCCDDEEFF", classId: "" });
    expect(res).toEqual({ ok: true, data: { id: "new-sensor-1" } });
    expect(classBelongsToTenantMock).not.toHaveBeenCalled();
  });
});

describe("updateSensorDeviceAction", () => {
  it("不正な sensorId は invalid、認可も走らせない", async () => {
    const res = await updateSensorDeviceAction("nope", { locationLabel: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("locationLabel が 120 文字超は invalid (DB 未到達)", async () => {
    const res = await updateSensorDeviceAction(SENSOR_ID, { locationLabel: "あ".repeat(121) });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("0 行 UPDATE (他校/不可視) は not_found", async () => {
    updateSensorDeviceMock.mockResolvedValue({ updated: false });
    const res = await updateSensorDeviceAction(OTHER_SENSOR_ID, { locationLabel: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("cross-tenant: 自校で不可視なクラスへ紐付けは invalid (更新前に弾く)", async () => {
    classBelongsToTenantMock.mockResolvedValue(false);
    const res = await updateSensorDeviceAction(SENSOR_ID, { classId: CLASS_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(updateSensorDeviceMock).not.toHaveBeenCalled();
  });

  it("正常系: 更新して id を返す (school_admin は自校に降格スコープ)", async () => {
    const res = await updateSensorDeviceAction(SENSOR_ID, {
      locationLabel: "新ラベル",
      classId: CLASS_ID,
    });
    expect(res).toEqual({ ok: true, data: { id: SENSOR_ID } });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
    expect(lastWithSessionOptions()).toEqual({ tenantScoped: true, schoolId: SCHOOL_ID });
    // updated_by = userRef。school_admin は自身の users.id。
    expect(updateSensorDeviceMock.mock.calls[0]?.[3]).toBe(USER_ID);
  });

  it("system_admin で targetSchoolId 未指定は forbidden (越境防止)", async () => {
    requireRoleMock.mockResolvedValue(sysAdmin);
    const res = await updateSensorDeviceAction(SENSOR_ID, { locationLabel: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("system_admin: 対象校代行 — updated_by=null (FK 回避) + 対象校に降格スコープ", async () => {
    requireRoleMock.mockResolvedValue(sysAdmin);
    const res = await updateSensorDeviceAction(
      SENSOR_ID,
      { locationLabel: "新ラベル" },
      TARGET_SCHOOL_ID,
    );
    expect(res).toEqual({ ok: true, data: { id: SENSOR_ID } });
    expect(lastWithSessionOptions()).toEqual({ tenantScoped: true, schoolId: TARGET_SCHOOL_ID });
    // updateSensorDevice(tx, id, fields, actorUserId) の 4 引数目 = userRef = null。
    expect(updateSensorDeviceMock.mock.calls[0]?.[3]).toBeNull();
  });
});
