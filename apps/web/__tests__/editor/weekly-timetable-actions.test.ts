import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 週次ベース時間割（F5）Server Action `setClassWeeklyTimetableAction` の配線テスト
 * （schedule-actions.test.ts と同パターン）。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は **mock しない**（action は drizzle の値を import するが、
 * withSession を mock するので tx は実行されない）。重点: 入力検証（classId / 曜日別ペイロード）が DB 到達前に
 * 弾かれること、認可（DAILY_DATA_EDITOR_ROLES / system_admin は targetSchoolId 無し＝forbidden）、
 * `withSession(..., { tenantScoped: true, schoolId })` への伝播、not_found の invalid 化。
 * RLS の実効（tenant 分離・WITH CHECK）は packages/db の実 PG テストに委譲。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { setClassWeeklyTimetableAction } from "../../lib/editor/weekly-timetable-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SYS_UID = "77777777-7777-4777-8777-777777777777";

/** daily_data 系 action の認可ロール (EDITOR_ROLES + system_admin)。 */
const DAILY_DATA_ROLES = ["school_admin", "teacher", "system_admin"];

const teacher = { uid: USER_ID, role: "teacher" as const, schoolId: SCHOOL_ID };
const TT = { "1": [{ period: 1, subject: "数学" }] };

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(teacher);
  withSessionMock.mockResolvedValue({ kind: "ok", id: "tpl-1" });
});

describe("setClassWeeklyTimetableAction", () => {
  it("不正な classId は invalid を返し、認可も走らせない", async () => {
    const res = await setClassWeeklyTimetableAction("nope", TT);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("検証 NG（曜日キー不正）は DB に到達せず invalid", async () => {
    const res = await setClassWeeklyTimetableAction(CLASS_ID, {
      "6": [{ period: 1, subject: "数学" }],
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("検証 NG（時限重複 / 空科目）は DB に到達せず invalid", async () => {
    const dup = await setClassWeeklyTimetableAction(CLASS_ID, {
      "1": [
        { period: 1, subject: "数学" },
        { period: 1, subject: "国語" },
      ],
    });
    expect(dup).toMatchObject({ ok: false, error: { code: "invalid" } });
    const empty = await setClassWeeklyTimetableAction(CLASS_ID, {
      "1": [{ period: 1, subject: "  " }],
    });
    expect(empty).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("DAILY_DATA_EDITOR_ROLES を認可する", async () => {
    await setClassWeeklyTimetableAction(CLASS_ID, TT);
    expect(requireRoleMock).toHaveBeenCalledWith(DAILY_DATA_ROLES);
  });

  it("正常系 (teacher): 保存 + withSession に自校 tenantScoped を渡し、エディタと /timetable を再検証する", async () => {
    const res = await setClassWeeklyTimetableAction(CLASS_ID, TT);
    expect(res).toEqual({ ok: true, data: { id: "tpl-1" } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: SCHOOL_ID,
    });
    // seed 元が変わるので、/timetable とエディタ本体（未 materialize 日の初期値）の両方を再検証。
    expect(revalidatePathMock).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}/timetable`);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/app/editor/${CLASS_ID}`);
  });

  it("空テンプレ（{}）も正常系（全曜日を消す＝テンプレ解除）", async () => {
    const res = await setClassWeeklyTimetableAction(CLASS_ID, {});
    expect(res).toEqual({ ok: true, data: { id: "tpl-1" } });
  });

  it("クラス不可視（別テナント / 不存在）＝ not_found は invalid にして返す", async () => {
    withSessionMock.mockResolvedValue({ kind: "not_found" });
    const res = await setClassWeeklyTimetableAction(CLASS_ID, TT);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("system_admin は targetSchoolId 経路が無いため forbidden（fail-closed）", async () => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
    const res = await setClassWeeklyTimetableAction(CLASS_ID, TT);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("学校に属さない tenant ユーザーは forbidden", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "teacher", schoolId: null });
    const res = await setClassWeeklyTimetableAction(CLASS_ID, TT);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });
});
