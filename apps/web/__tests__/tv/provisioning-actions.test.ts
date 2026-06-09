import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C方式 TV プロビジョニング Server Action の配線テスト。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は `importOriginal` で実体を保ちつつ `createTvDevice` /
 * `createProvisioningJob` だけ差し替える（signage 純ロジック generateToken/hashToken/buildSignageUrl と
 * auditLog/magicLinks テーブル参照は実体を使う）。`withSession` は callback を fake tx で実行し、inline INSERT
 * （magic_links / audit_log）を capture する。
 *
 * 重点: 入力検証で DB に到達しないこと（不正 school/class/IP）、認可（ONBOARDING_ROLES = system_admin）、
 * 正常系の結線（signage_url 発行 → device 事前作成 → magic link(hash) → 監査 → job 作成 → {jobId,deviceId,
 * signageUrl} 返却）、device_id 自動採番、23505→conflict / 23503→invalid 写像。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const createTvDeviceMock = vi.fn();
const createProvisioningJobMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    createTvDevice: (...a: unknown[]) => createTvDeviceMock(...a),
    createProvisioningJob: (...a: unknown[]) => createProvisioningJobMock(...a),
  };
});

import { auditLog, magicLinks } from "@kimiterrace/db";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { createProvisioningJobAction } from "../../lib/tv/provisioning-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const CLASS_ID = "22222222-2222-4222-8222-222222222222";
const USER_UID = "sysadmin-uid-xyz";
const ROW_ID = "33333333-3333-4333-8333-333333333333";
const DEVICE_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";

const sysadmin = { uid: USER_UID, role: "system_admin" as const, schoolId: null };

const VALID = {
  schoolId: SCHOOL_ID,
  classId: CLASS_ID,
  label: "電子工学科 1年",
  targetMac: "DC:A5:B3:C2:98:A1",
  schedule: { enabled: true, onHour: 8, offHour: 17, weekdays: [1, 2, 3, 4, 5] },
};

/** inline INSERT（magic_links / audit_log）を capture する fake tx。 */
const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
function fakeTx() {
  return {
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        inserts.push({ table, values: v });
        return Promise.resolve(undefined);
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  requireRoleMock.mockResolvedValue(sysadmin);
  createTvDeviceMock.mockResolvedValue({ id: ROW_ID, deviceId: DEVICE_ID });
  createProvisioningJobMock.mockResolvedValue({ id: JOB_ID });
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysadmin))) as typeof withSession);
});

describe("createProvisioningJobAction", () => {
  it("schoolId 不正 → invalid、DB・認可に到達しない", async () => {
    const res = await createProvisioningJobAction({ schoolId: "nope", classId: CLASS_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("classId 不正 → invalid", async () => {
    const res = await createProvisioningJobAction({ schoolId: SCHOOL_ID, classId: "nope" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("targetIp 不正 → invalid", async () => {
    const res = await createProvisioningJobAction({ ...VALID, targetIp: "999.1.1.1" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("ONBOARDING_ROLES (system_admin) のみ認可する", async () => {
    await createProvisioningJobAction(VALID);
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("正常系: signage 発行 → device 事前作成 → magic link → 監査 → job 作成、{jobId,deviceId,signageUrl} を返す", async () => {
    const res = await createProvisioningJobAction(VALID);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.jobId).toBe(JOB_ID);
      expect(res.data.deviceId).toBe(DEVICE_ID);
      expect(res.data.signageUrl).toMatch(/\/signage\/[A-Za-z0-9_-]+$/);
    }
    // createTvDevice に signage_url が焼かれる。
    expect(createTvDeviceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        schoolId: SCHOOL_ID,
        label: "電子工学科 1年",
        signageUrl: expect.stringContaining("/signage/"),
        createdBy: null,
      }),
    );
    // createProvisioningJob に class/device/signage を結線（actor は system_admin = actorUserId null）。
    expect(createProvisioningJobMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        schoolId: SCHOOL_ID,
        classId: CLASS_ID,
        tvDeviceRowId: ROW_ID,
        deviceId: DEVICE_ID,
        actorUserId: null,
        actorIdentityUid: USER_UID,
      }),
    );
    // magic_links: class スコープ・userId null・tokenHash は 64 hex（hash のみ保存、ルール5）。
    const ml = inserts.find((i) => i.table === magicLinks);
    expect(ml).toBeTruthy();
    expect(ml?.values).toMatchObject({ schoolId: SCHOOL_ID, classId: CLASS_ID, userId: null });
    expect(String(ml?.values.tokenHash)).toMatch(/^[0-9a-f]{64}$/);
    // 監査: tv_devices の insert を 1 件（system_admin は actorUserId null + actorIdentityUid）。
    const audit = inserts.find((i) => i.table === auditLog);
    expect(audit?.values).toMatchObject({
      tableName: "tv_devices",
      operation: "insert",
      recordId: ROW_ID,
      schoolId: SCHOOL_ID,
      actorUserId: null,
      actorIdentityUid: USER_UID,
    });
  });

  it("device_id 未指定なら自動採番（createTvDevice に UUID が渡る）", async () => {
    await createProvisioningJobAction(VALID);
    const arg = createTvDeviceMock.mock.calls[0]?.[1] as { deviceId: string };
    expect(arg.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("device_id 重複 (23505) → conflict", async () => {
    createTvDeviceMock.mockRejectedValue({ code: "23505" });
    const res = await createProvisioningJobAction(VALID);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("school/class FK 違反 (23503) → invalid（class が当該校に属さない等）", async () => {
    createProvisioningJobMock.mockRejectedValue({ code: "23503" });
    const res = await createProvisioningJobAction(VALID);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});
