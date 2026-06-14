import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 運営整理 §4 item5: setSensorDecommissionedAction (全校・system_admin の撤去/再稼働) の配線テスト。
 * next/cache・guard・db・@kimiterrace/db(getOwnSensorDevice/setSensorDecommissioned) を mock。
 * 不正入力・認可・not_found・監査(system_admin パターン: actor NULL + actor_identity_uid + 対象校 id)・
 * 撤去/再稼働の値写像を確認する。RLS 実挙動は packages/db の RLS テストが担保 (実 PG)。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("@kimiterrace/db", () => ({
  auditLog: {},
  getOwnSensorDevice: vi.fn(),
  setSensorDecommissioned: vi.fn(),
}));

import { getOwnSensorDevice, setSensorDecommissioned } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { setSensorDecommissionedAction } from "../../lib/system-admin/sensor-ops-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);
const getMock = vi.mocked(getOwnSensorDevice);
const setMock = vi.mocked(setSensorDecommissioned);

const SENSOR_ID = "55555555-5555-4555-8555-555555555555";
const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

let auditValues: Record<string, unknown> | null;

function fakeTx() {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        auditValues = v;
        return Promise.resolve(undefined);
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  auditValues = null;
  // 既定: 稼働中 (decommissionedAt=null) のセンサーが見える / 更新は 1 行成功。
  getMock.mockResolvedValue({
    id: SENSOR_ID,
    schoolId: SCHOOL_ID,
    decommissionedAt: null,
  } as unknown as Awaited<ReturnType<typeof getOwnSensorDevice>>);
  setMock.mockResolvedValue({ updated: true, id: SENSOR_ID });
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("setSensorDecommissionedAction", () => {
  it("不正な id は invalid を返し、認可も DB も走らせない", async () => {
    const res = await setSensorDecommissionedAction({ id: "nope", decommissioned: true });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("decommissioned が boolean でないと invalid で DB に到達しない", async () => {
    const res = await setSensorDecommissionedAction({ id: SENSOR_ID, decommissioned: "yes" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES で呼ぶ", async () => {
    await setSensorDecommissionedAction({ id: SENSOR_ID, decommissioned: true });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("対象が不可視 / 不存在 (before null) は not_found、更新も監査もしない", async () => {
    getMock.mockResolvedValue(null);
    const res = await setSensorDecommissionedAction({ id: SENSOR_ID, decommissioned: true });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(setMock).not.toHaveBeenCalled();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("UPDATE が 0 行 (RLS 越境の多層防御) も not_found に倒し監査しない", async () => {
    setMock.mockResolvedValue({ updated: false });
    const res = await setSensorDecommissionedAction({ id: SENSOR_ID, decommissioned: true });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(auditValues).toBeNull();
  });

  it("撤去 (true): decommissioned_at に Date を渡し、監査は system_admin パターン + 対象校 id", async () => {
    const res = await setSensorDecommissionedAction({ id: SENSOR_ID, decommissioned: true });
    expect(res).toEqual({ ok: true, data: { id: SENSOR_ID, decommissioned: true } });
    // setSensorDecommissioned(tx, id, <Date>, null=system_admin)。
    const call = setMock.mock.calls[0];
    expect(call?.[1]).toBe(SENSOR_ID);
    expect(call?.[2]).toBeInstanceOf(Date);
    expect(call?.[3]).toBeNull();
    expect(auditValues).toMatchObject({
      actorUserId: null,
      actorIdentityUid: SYS_UID,
      schoolId: SCHOOL_ID,
      tableName: "sensor_devices",
      recordId: SENSOR_ID,
      operation: "update",
      createdBy: null,
      updatedBy: null,
      diff: { before: { decommissioned: false }, after: { decommissioned: true } },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/ops/sensors");
  });

  it("再稼働 (false): decommissioned_at に null を渡し、diff は before 撤去済 → after 稼働", async () => {
    getMock.mockResolvedValue({
      id: SENSOR_ID,
      schoolId: SCHOOL_ID,
      decommissionedAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof getOwnSensorDevice>>);
    const res = await setSensorDecommissionedAction({ id: SENSOR_ID, decommissioned: false });
    expect(res).toEqual({ ok: true, data: { id: SENSOR_ID, decommissioned: false } });
    const call = setMock.mock.calls[0];
    expect(call?.[2]).toBeNull();
    expect(auditValues).toMatchObject({
      diff: { before: { decommissioned: true }, after: { decommissioned: false } },
    });
  });
});
