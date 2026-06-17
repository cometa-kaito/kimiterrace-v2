import { beforeEach, describe, expect, it, vi } from "vitest";

// next/cache・guard・db を mock。@kimiterrace/db は **mock しない** (action は drizzle の値
// (auditLog/classes/dailyData) を import するが、withSession を mock するので tx は実行されない)。
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  setAssignmentsAction,
  setClassAssignmentsAction,
  setClassNoticesAction,
  setNoticesAction,
} from "../../lib/editor/notice-assignment-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DATE = "2026-06-01";

/** daily_data 3 action の認可ロール (EDITOR_ROLES + system_admin)。 */
const DAILY_DATA_ROLES = ["school_admin", "teacher", "system_admin"];

const teacher = { uid: USER_ID, role: "teacher" as const, schoolId: SCHOOL_ID };

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(teacher);
  // withSession に渡される callback は実行されない (DB 非接続)。固定 id を返す。
  withSessionMock.mockResolvedValue("daily-1");
});

describe("setClassNoticesAction", () => {
  it("不正な classId は invalid を返し、認可も走らせない", async () => {
    const res = await setClassNoticesAction("not-a-uuid", DATE, []);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("不正な date は invalid", async () => {
    const res = await setClassNoticesAction(CLASS_ID, "2026-02-30", []);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("検証 NG (空 text) は DB に到達せず invalid", async () => {
    const res = await setClassNoticesAction(CLASS_ID, DATE, [{ text: "" }]);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("DAILY_DATA_EDITOR_ROLES (school_admin/teacher/system_admin) を認可する", async () => {
    await setClassNoticesAction(CLASS_ID, DATE, [{ text: "x" }]);
    expect(requireRoleMock).toHaveBeenCalledWith(DAILY_DATA_ROLES);
  });

  it("schoolId 無し (system_admin で対象校未指定) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await setClassNoticesAction(CLASS_ID, DATE, [{ text: "x" }]);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("正常系: 保存して id を返す + withSession に自校 tenantScoped を渡す", async () => {
    const res = await setClassNoticesAction(CLASS_ID, DATE, [{ text: "x", isHighlight: true }]);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledTimes(1);
    // tenant ロール: system_admin 降格 (tenantScoped) で実行、schoolId は自校 (越境は withSession が封じる)。
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: SCHOOL_ID,
    });
  });
});

describe("setClassAssignmentsAction", () => {
  it("不正な classId は invalid を返し、認可も走らせない", async () => {
    const res = await setClassAssignmentsAction("nope", DATE, []);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("検証 NG (実在しない deadline) は DB に到達せず invalid", async () => {
    const res = await setClassAssignmentsAction(CLASS_ID, DATE, [
      { deadline: "2026-02-30", subject: "x", task: "y" },
    ]);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("schoolId 無しは forbidden", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await setClassAssignmentsAction(CLASS_ID, DATE, [
      { deadline: DATE, subject: "数学", task: "ワーク" },
    ]);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("正常系: 保存して id を返す", async () => {
    const res = await setClassAssignmentsAction(CLASS_ID, DATE, [
      { deadline: DATE, subject: "数学", task: "ワーク p.10" },
    ]);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(requireRoleMock).toHaveBeenCalledWith(DAILY_DATA_ROLES);
  });
});

/**
 * scope 汎用版 (`setNoticesAction` / `setAssignmentsAction`) + system_admin 対象校スコープの配線
 * (ads-actions.test.ts と同型)。tenant ロールの自校固定 (targetSchoolId 無視) と、system_admin の
 * `targetSchoolId` が `withSession(..., { tenantScoped: true, schoolId })` へ伝播することを固定する。
 * 越境封じの実効 (override は system_admin のみ honor / 降格 RLS) は packages/db の実 PG テストに委譲。
 */
describe("scope 汎用 + system_admin 対象校スコープの配線", () => {
  const SYS_UID = "77777777-7777-4777-8777-777777777777";
  const TARGET = "88888888-8888-4888-8888-888888888888";

  it("school_admin が他校 targetSchoolId を渡しても自校に固定する (越境不可)", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "school_admin", schoolId: SCHOOL_ID });
    const OTHER_SCHOOL = "abababab-abab-4bab-8bab-abababababab";
    const res = await setNoticesAction("class", CLASS_ID, DATE, [{ text: "x" }], OTHER_SCHOOL);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: SCHOOL_ID,
    });
  });

  it("system_admin: 対象校未指定は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
    const res = await setNoticesAction("class", CLASS_ID, DATE, [{ text: "x" }]);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("system_admin: notices 対象校指定で withSession に { tenantScoped, schoolId } を渡す", async () => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
    const res = await setNoticesAction("class", CLASS_ID, DATE, [{ text: "x" }], TARGET);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: TARGET,
    });
  });

  it("system_admin: assignments 対象校指定で対象校 schoolId を渡す", async () => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
    const res = await setAssignmentsAction(
      "class",
      CLASS_ID,
      DATE,
      [{ deadline: DATE, subject: "数学", task: "ワーク" }],
      TARGET,
    );
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: TARGET,
    });
  });
});
