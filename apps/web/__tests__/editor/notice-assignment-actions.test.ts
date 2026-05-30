import { beforeEach, describe, expect, it, vi } from "vitest";

// next/cache・guard・db を mock。@kimiterrace/db は **mock しない** (action は drizzle の値
// (auditLog/classes/dailyData) を import するが、withSession を mock するので tx は実行されない)。
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  setClassAssignmentsAction,
  setClassNoticesAction,
} from "../../lib/editor/notice-assignment-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DATE = "2026-06-01";

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

  it("EDITOR_ROLES (school_admin/teacher) のみ認可する", async () => {
    await setClassNoticesAction(CLASS_ID, DATE, [{ text: "x" }]);
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "teacher"]);
  });

  it("schoolId 無し (system_admin 等) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await setClassNoticesAction(CLASS_ID, DATE, [{ text: "x" }]);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("正常系: 保存して id を返す", async () => {
    const res = await setClassNoticesAction(CLASS_ID, DATE, [{ text: "x", isHighlight: true }]);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledTimes(1);
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
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "teacher"]);
  });
});
