import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * エディタ Schedule Server Action の配線テスト (C1: system_admin 対象校スコープ土台)。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は **mock しない** (action は drizzle の値を
 * import するが、withSession を mock するので tx は実行されない)。重点: 認可
 * (DAILY_DATA_EDITOR_ROLES / forbidden)、後方互換 class 版 (targetSchoolId なし = 自校固定)、
 * system_admin 対象校スコープが `withSession(..., { tenantScoped: true, schoolId })` へ伝播すること。
 * 越境封じの実効 (override は system_admin のみ honor / 降格 RLS) は packages/db の実 PG テストに委譲。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { setClassScheduleAction, setScheduleAction } from "../../lib/editor/schedule-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SYS_UID = "77777777-7777-4777-8777-777777777777";
const TARGET = "88888888-8888-4888-8888-888888888888";
const DATE = "2026-06-01";

/** daily_data 3 action の認可ロール (EDITOR_ROLES + system_admin)。 */
const DAILY_DATA_ROLES = ["school_admin", "teacher", "system_admin"];

const teacher = { uid: USER_ID, role: "teacher" as const, schoolId: SCHOOL_ID };
const ITEMS = [{ period: 1, subject: "数学" }];

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(teacher);
  withSessionMock.mockResolvedValue("daily-1");
});

describe("setScheduleAction", () => {
  it("不正な targetId (class) は invalid を返し、認可も走らせない", async () => {
    const res = await setScheduleAction("class", "nope", DATE, ITEMS);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("不正な date は invalid", async () => {
    const res = await setScheduleAction("class", CLASS_ID, "2026-02-30", ITEMS);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("検証 NG (空科目) は DB に到達せず invalid", async () => {
    const res = await setScheduleAction("class", CLASS_ID, DATE, [{ period: 1, subject: "  " }]);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("DAILY_DATA_EDITOR_ROLES を認可する", async () => {
    await setScheduleAction("class", CLASS_ID, DATE, ITEMS);
    expect(requireRoleMock).toHaveBeenCalledWith(DAILY_DATA_ROLES);
  });

  it("正常系 (tenant ロール): 保存 + withSession に自校 tenantScoped を渡す", async () => {
    const res = await setScheduleAction("class", CLASS_ID, DATE, ITEMS);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: SCHOOL_ID,
    });
  });

  it("正常系 (school スコープ, id 不要): 保存して id を返す", async () => {
    const res = await setScheduleAction("school", null, DATE, ITEMS);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
  });

  it("school_admin が他校 targetSchoolId を渡しても自校に固定する (越境不可)", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "school_admin", schoolId: SCHOOL_ID });
    const OTHER_SCHOOL = "abababab-abab-4bab-8bab-abababababab";
    const res = await setScheduleAction("class", CLASS_ID, DATE, ITEMS, OTHER_SCHOOL);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: SCHOOL_ID,
    });
  });
});

describe("setClassScheduleAction (後方互換)", () => {
  it("targetSchoolId を取らず class target に委譲 (自校固定・回帰なし)", async () => {
    const res = await setClassScheduleAction(CLASS_ID, DATE, ITEMS);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: SCHOOL_ID,
    });
  });
});

describe("setScheduleAction: system_admin 対象校スコープの配線", () => {
  beforeEach(() => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
  });

  it("対象校未指定は forbidden、DB に到達しない", async () => {
    const res = await setScheduleAction("class", CLASS_ID, DATE, ITEMS);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象校指定で withSession に { tenantScoped, schoolId } を渡す", async () => {
    const res = await setScheduleAction("class", CLASS_ID, DATE, ITEMS, TARGET);
    expect(res).toEqual({ ok: true, data: { id: "daily-1" } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: TARGET,
    });
  });
});
