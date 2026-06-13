import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F01/F02 (#509 S3b) createDraftFromInputAction の単体テスト。
 *
 * withSession をモックしてその outcome → 結果マッピングと、uuid 検証・認可ゲート順を検証する。
 * DB ロジック (getTeacherInput / createContent / submitTeacherInput) の実挙動は S3a の RLS テスト等で担保。
 * guard は requireUser を mock、純粋な isRoleAllowed は実装そのまま (認可分岐を実挙動で突く)。
 * redirect は throw する mock で /forbidden 遷移を検証する。
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock("../../lib/auth/guard", () => ({
  requireUser: vi.fn(),
  isRoleAllowed: (role: string, allowed: readonly string[]) => allowed.includes(role),
}));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { redirect } from "next/navigation";
import { requireUser } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { createDraftFromInputAction } from "../../lib/teacher-input/draft-actions";

const requireUserMock = vi.mocked(requireUser);
const withSessionMock = vi.mocked(withSession);
const redirectMock = vi.mocked(redirect);

const INPUT_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
// teacher-input の正常系 staff actor = school_admin（finding⑧ で teacher を TEACHER_INPUT_STAFF_ROLES から除外）。
const teacher = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };
const student = { uid: USER_ID, role: "student" as const, schoolId: SCHOOL_ID };

beforeEach(() => {
  vi.clearAllMocks();
  requireUserMock.mockResolvedValue(teacher);
});

describe("createDraftFromInputAction", () => {
  it("不正な inputId は invalid_input を返し、認証も走らせない", async () => {
    const res = await createDraftFromInputAction("not-a-uuid");
    expect(res).toEqual({ ok: false, code: "invalid_input", message: expect.any(String) });
    expect(requireUserMock).not.toHaveBeenCalled();
  });

  it("正常系: withSession の ok outcome を contentId に写像する", async () => {
    withSessionMock.mockResolvedValue({ kind: "ok", contentId: "content-1" });
    const res = await createDraftFromInputAction(INPUT_ID);
    expect(res).toEqual({ ok: true, contentId: "content-1" });
    expect(requireUserMock).toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("入力が無い (not_found) は not_found を返す", async () => {
    withSessionMock.mockResolvedValue({ kind: "not_found" });
    const res = await createDraftFromInputAction(INPUT_ID);
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });

  it("transcript 空 (no_transcript) は no_transcript を返す", async () => {
    withSessionMock.mockResolvedValue({ kind: "no_transcript" });
    const res = await createDraftFromInputAction(INPUT_ID);
    expect(res).toMatchObject({ ok: false, code: "no_transcript" });
  });

  it("非 publisher (生徒) は /forbidden に redirect する", async () => {
    requireUserMock.mockResolvedValue(student);
    await expect(createDraftFromInputAction(INPUT_ID)).rejects.toThrow("REDIRECT:/forbidden");
    expect(redirectMock).toHaveBeenCalledWith("/forbidden");
    expect(withSessionMock).not.toHaveBeenCalled();
  });
});
