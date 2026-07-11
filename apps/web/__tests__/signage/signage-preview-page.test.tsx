import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * サイネージプレビュー (`/app/signage-preview/[classId]`) の **RLS スコープ配線**テスト（#1264）。
 *
 * system_admin は自校を持たず `system_admin_full_access` で全校可視のため、素の tx で
 * display_settings（school_id 条件なしの LIMIT 1）を読むと**別校**の
 * assignmentDeadlineFormat / signageDesign を拾いうる。ページは対象クラスから school_id を導出し
 * （`getVisibleClassSchoolId`）、本体 tx を `withSession(..., { tenantScoped: true, schoolId })` で
 * 対象校に降格スコープする（ADR-041 P1・/ops エディタと同型）。ここでは以下を固定する:
 *
 * 1. system_admin: 導出 → 降格スコープ tx で読み、**対象クラスの学校**の設定が SignageBoard に渡る
 * 2. system_admin + 不可視/不存在クラス: 導出 null → notFound（本体 fetch に進まない）
 * 3. tenant ロール（school_admin/teacher）: 導出の round-trip なし・自校固定（schoolId=null・回帰なし）
 *
 * guard / db / DB 読取層は mock（editor-index-page.test と同作法）。tx に「どの学校スコープで開いたか」
 * を刻み、getSchoolDisplaySettings mock が学校別の設定を返すことでスコープ誤りを検出可能にする。
 */

vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("../../lib/signage/effective-daily-data", () => ({ getEffectiveDailyData: vi.fn() }));
vi.mock("../../lib/signage/signage-design", () => ({ getSchoolDisplaySettings: vi.fn() }));

const getEffectiveAdsForClassMock = vi.fn();
const getVisibleClassSchoolIdMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    getEffectiveAdsForClass: (...a: unknown[]) => getEffectiveAdsForClassMock(...a),
    getVisibleClassSchoolId: (...a: unknown[]) => getVisibleClassSchoolIdMock(...a),
  };
});
// notFound は本物同様 throw で描画を止める（捕捉して分岐を検証する）。
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

import { notFound } from "next/navigation";
import SignagePreviewPage from "../../app/app/signage-preview/[classId]/page";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { getEffectiveDailyData } from "../../lib/signage/effective-daily-data";
import { getSchoolDisplaySettings } from "../../lib/signage/signage-design";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const getEffectiveDailyDataMock = vi.mocked(getEffectiveDailyData);
const getSchoolDisplaySettingsMock = vi.mocked(getSchoolDisplaySettings);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_SCHOOL_ID = "22222222-2222-4222-8222-222222222222"; // 対象クラスの所属校
const OTHER_SCHOOL_ID = "99999999-9999-4999-8999-999999999999"; // 別校（拾ってはいけない）
const USER_ID = "33333333-3333-4333-8333-333333333333";

const sysAdmin = { uid: USER_ID, role: "system_admin" as const, schoolId: null };
const schoolAdmin = { uid: USER_ID, role: "school_admin" as const, schoolId: TARGET_SCHOOL_ID };

/** ページ呼び出し（Server Component を直接実行）。 */
function renderPage() {
  return SignagePreviewPage({
    params: Promise.resolve({ classId: CLASS_ID }),
    searchParams: Promise.resolve({}),
  });
}

/**
 * withSession を「tx にスコープ校を刻む」実装で束ねる。options.schoolId 未指定（tenant ロール相当）は
 * user.schoolId に固定される実物の挙動を模す。
 */
function stubSession(user: { schoolId: string | null }) {
  withSessionMock.mockImplementation(((
    fn: (tx: unknown, user: unknown) => unknown,
    options?: { tenantScoped?: boolean; schoolId?: string | null },
  ) =>
    Promise.resolve(
      fn({ scopedSchoolId: options?.schoolId ?? user.schoolId }, user),
    )) as typeof withSession);
}

/** 学校ごとに異なる display_settings（スコープ誤り = 別校の形式が返る、を検出する）。 */
const SETTINGS_BY_SCHOOL: Record<string, unknown> = {
  [TARGET_SCHOOL_ID]: { assignmentDeadlineFormat: "until", signageDesign: "pattern2" },
  [OTHER_SCHOOL_ID]: { assignmentDeadlineFormat: "daysLeft", signageDesign: "pattern1" },
};

const EMPTY_SECTION = { items: [], source: null };
const DAILY = {
  date: "2026-07-12",
  schedules: EMPTY_SECTION,
  notices: EMPTY_SECTION,
  assignments: EMPTY_SECTION,
  quietHours: EMPTY_SECTION,
};

beforeEach(() => {
  vi.clearAllMocks();
  getVisibleClassSchoolIdMock.mockResolvedValue(TARGET_SCHOOL_ID);
  getEffectiveDailyDataMock.mockResolvedValue(DAILY);
  getEffectiveAdsForClassMock.mockResolvedValue([]);
  getSchoolDisplaySettingsMock.mockImplementation(async (tx: unknown) => {
    const { scopedSchoolId } = tx as { scopedSchoolId: string | null };
    // full_access（スコープ校なし）は順序不定 LIMIT 1 = 別校の行が返る最悪ケースを模す。
    return SETTINGS_BY_SCHOOL[scopedSchoolId ?? OTHER_SCHOOL_ID];
  });
});

describe("SignagePreviewPage の学校スコープ (#1264)", () => {
  it("system_admin: クラスから学校を導出し、降格スコープ tx で対象校の期日形式が盤面に渡る", async () => {
    requireRoleMock.mockResolvedValue(sysAdmin);
    stubSession(sysAdmin);

    const el = await renderPage();

    // 導出は素の session（full_access 読取）、本体 fetch は対象校へ降格スコープ。
    expect(getVisibleClassSchoolIdMock).toHaveBeenCalledTimes(1);
    expect(withSessionMock).toHaveBeenCalledTimes(2);
    expect(withSessionMock.mock.calls[1]?.[1]).toEqual({
      tenantScoped: true,
      schoolId: TARGET_SCHOOL_ID,
    });
    // 別校（OTHER_SCHOOL_ID）の "daysLeft" ではなく、対象クラスの学校の "until" が渡る。
    expect(el.props).toMatchObject({ assignmentDeadlineFormat: "until" });
  });

  it("system_admin: クラスが不可視/不存在（導出 null）なら notFound で本体 fetch に進まない", async () => {
    requireRoleMock.mockResolvedValue(sysAdmin);
    stubSession(sysAdmin);
    getVisibleClassSchoolIdMock.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    expect(withSessionMock).toHaveBeenCalledTimes(1); // 導出のみ。本体 fetch なし
    expect(getEffectiveDailyDataMock).not.toHaveBeenCalled();
  });

  it("tenant ロール（school_admin）: 導出の round-trip なし・自校スコープで従来動作（回帰なし）", async () => {
    requireRoleMock.mockResolvedValue(schoolAdmin);
    stubSession(schoolAdmin);

    const el = await renderPage();

    expect(getVisibleClassSchoolIdMock).not.toHaveBeenCalled();
    expect(withSessionMock).toHaveBeenCalledTimes(1);
    // schoolId=null（override なし）= 実物 withSession はセッションの自校に固定する。
    expect(withSessionMock.mock.calls[0]?.[1]).toEqual({ tenantScoped: true, schoolId: null });
    expect(el.props).toMatchObject({ assignmentDeadlineFormat: "until" });
  });
});
