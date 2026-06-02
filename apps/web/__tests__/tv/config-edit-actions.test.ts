import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F15 §4.2 (ADR-022): TV 設定編集 Server Action の配線テスト。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は `importOriginal` で実体を保ちつつ
 * `updateTvDeviceConfig` だけ差し替えて version バンプ呼び出し / not_found 分岐 / 監査配線を検証する。
 * `withSession` は callback を fake tx で実行する。
 *
 * 重点: 認可 (TV_CONFIG_EDIT_ROLES / forbidden)、入力検証で DB に到達しないこと（不正 id / URL / 長さ /
 * schedule）、0 行 → not_found 写像、audit が tv_devices に operation=update で 1 件、tenantScoped 指定。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const updateTvDeviceConfigMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    updateTvDeviceConfig: (...a: unknown[]) => updateTvDeviceConfigMock(...a),
  };
});

import { auditLog } from "@kimiterrace/db";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { updateTvDeviceConfigAction } from "../../lib/tv/config-edit-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const ROW_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const admin = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };

const VALID_INPUT = {
  label: "電子工学科 1年",
  signageUrl: "https://sig.example/?school=A",
  targetMac: "DC:A5:B3:C2:98:A1",
  monitoringEnabled: true,
  schedule: { enabled: true, onHour: 8, offHour: 18 },
};

/** audit_log の .insert(...).values(...) を満たす fake tx。値を capture する。 */
let auditInsertTable: unknown;
let auditValues: unknown;
let lastSessionOptions: unknown;
function fakeTx() {
  return {
    insert: (table: unknown) => {
      auditInsertTable = table;
      return {
        values: (v: unknown) => {
          auditValues = v;
          return Promise.resolve(undefined);
        },
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditInsertTable = undefined;
  auditValues = undefined;
  lastSessionOptions = undefined;
  requireRoleMock.mockResolvedValue(admin);
  updateTvDeviceConfigMock.mockResolvedValue({ id: ROW_ID, version: 6 });
  withSessionMock.mockImplementation(((
    fn: (tx: unknown, user: unknown) => unknown,
    options: unknown,
  ) => {
    lastSessionOptions = options;
    return Promise.resolve(fn(fakeTx(), admin));
  }) as typeof withSession);
});

describe("updateTvDeviceConfigAction", () => {
  it("不正な行 id は invalid を返し、認可も走らせない", async () => {
    const res = await updateTvDeviceConfigAction("nope", VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("非 http(s) の signage_url は invalid（DB に到達しない）", async () => {
    const res = await updateTvDeviceConfigAction(ROW_ID, {
      ...VALID_INPUT,
      signageUrl: "javascript:alert(1)",
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("ラベル長さ超過は invalid（DB に到達しない）", async () => {
    const res = await updateTvDeviceConfigAction(ROW_ID, {
      ...VALID_INPUT,
      label: "あ".repeat(201),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("schedule の形不正（enabled 非 boolean）は invalid", async () => {
    const res = await updateTvDeviceConfigAction(ROW_ID, {
      ...VALID_INPUT,
      schedule: { enabled: "yes" },
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("TV_CONFIG_EDIT_ROLES (school_admin/system_admin) のみ認可する", async () => {
    await updateTvDeviceConfigAction(ROW_ID, VALID_INPUT);
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("schoolId 無し（テナント未選択 system_admin）は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await updateTvDeviceConfigAction(ROW_ID, VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("0 行（他校 / 不可視 / 退役）は not_found に写像し、audit を書かない", async () => {
    updateTvDeviceConfigMock.mockResolvedValue(undefined);
    const res = await updateTvDeviceConfigAction(ROW_ID, VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(auditValues).toBeUndefined();
  });

  it("正常系: update + audit operation=update（tv_devices）、version を返す", async () => {
    const res = await updateTvDeviceConfigAction(ROW_ID, VALID_INPUT);
    expect(res).toEqual({ ok: true, data: { id: ROW_ID, version: 6 } });
    expect(updateTvDeviceConfigMock).toHaveBeenCalledTimes(1);
    expect(auditInsertTable).toBe(auditLog);
    expect(auditValues).toMatchObject({
      tableName: "tv_devices",
      operation: "update",
      recordId: ROW_ID,
      schoolId: SCHOOL_ID,
      actorUserId: USER_ID,
    });
  });

  it("tenantScoped: true で実行する（system_admin の全校発火を止める）", async () => {
    await updateTvDeviceConfigAction(ROW_ID, VALID_INPUT);
    expect(lastSessionOptions).toMatchObject({ tenantScoped: true });
  });

  it("update の引数: 編集パッチ + actorUserId を結線（システム管理列は含まない）", async () => {
    await updateTvDeviceConfigAction(ROW_ID, VALID_INPUT);
    expect(updateTvDeviceConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: ROW_ID,
        actorUserId: USER_ID,
        patch: expect.objectContaining({
          label: "電子工学科 1年",
          signageUrl: "https://sig.example/?school=A",
          targetMac: "DC:A5:B3:C2:98:A1",
          monitoringEnabled: true,
          scheduleJson: { enabled: true, onHour: 8, offHour: 18 },
        }),
      }),
    );
    // パッチに version / device_id / school_id 等のシステム管理列が紛れていないこと。
    const callArg = updateTvDeviceConfigMock.mock.calls[0]?.[1] as {
      patch: Record<string, unknown>;
    };
    expect(callArg.patch).not.toHaveProperty("version");
    expect(callArg.patch).not.toHaveProperty("deviceId");
    expect(callArg.patch).not.toHaveProperty("schoolId");
  });
});
