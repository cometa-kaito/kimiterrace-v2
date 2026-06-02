import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F15 §4.2 (ADR-022): TV リモートコマンド発行 Server Action の配線テスト。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は `importOriginal` で実体を保ちつつ
 * `enqueueTvCommand` だけ差し替えて呼び出し / device_not_found 分岐 / 結線を検証する。
 * `withSession` は callback を fake tx で実行する。
 *
 * 重点: 認可 (TV_CONFIG_EDIT_ROLES / forbidden)、入力検証で DB に到達しないこと（不正 id / 不正コマンド）、
 * device_not_found → not_found 写像、tenantScoped 指定、enqueueTvCommand への引数結線。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const enqueueTvCommandMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    enqueueTvCommand: (...a: unknown[]) => enqueueTvCommandMock(...a),
  };
});

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { enqueueTvCommandAction } from "../../lib/tv/command-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const ROW_ID = "44444444-4444-4444-8444-444444444444";
const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "66666666-6666-4666-8666-666666666666";

const admin = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };

let lastSessionOptions: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  lastSessionOptions = undefined;
  requireRoleMock.mockResolvedValue(admin);
  enqueueTvCommandMock.mockResolvedValue({ status: "enqueued", id: "cmd-1", deviceId: "dev-A" });
  withSessionMock.mockImplementation(((
    fn: (tx: unknown, user: unknown) => unknown,
    options: unknown,
  ) => {
    lastSessionOptions = options;
    return Promise.resolve(fn({}, admin));
  }) as typeof withSession);
});

describe("enqueueTvCommandAction", () => {
  it("不正な行 id は invalid を返し、認可も走らせない", async () => {
    const res = await enqueueTvCommandAction("nope", "signage_reload");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("未知のコマンド種別は invalid（DB に到達しない）", async () => {
    const res = await enqueueTvCommandAction(ROW_ID, "drop_table");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("TV_CONFIG_EDIT_ROLES (school_admin/system_admin) のみ認可する", async () => {
    await enqueueTvCommandAction(ROW_ID, "signage_reload");
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("schoolId 無し（テナント未選択 system_admin）は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await enqueueTvCommandAction(ROW_ID, "signage_reload");
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("device_not_found は not_found に写像する", async () => {
    enqueueTvCommandMock.mockResolvedValue({ status: "device_not_found" });
    const res = await enqueueTvCommandAction(ROW_ID, "signage_reload");
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: enqueue 成功で id を返す", async () => {
    const res = await enqueueTvCommandAction(ROW_ID, "service_restart");
    expect(res).toEqual({ ok: true, data: { id: "cmd-1" } });
    expect(enqueueTvCommandMock).toHaveBeenCalledTimes(1);
  });

  it("tenantScoped: true で実行する（system_admin の全校発火を止める）", async () => {
    await enqueueTvCommandAction(ROW_ID, "signage_reload");
    expect(lastSessionOptions).toMatchObject({ tenantScoped: true });
  });

  it("enqueue の引数: deviceRowId / command / actor を結線する", async () => {
    await enqueueTvCommandAction(ROW_ID, "signage_open");
    expect(enqueueTvCommandMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deviceRowId: ROW_ID,
        command: "signage_open",
        actorUserId: USER_ID,
        actorSchoolId: SCHOOL_ID,
      }),
    );
  });
});
