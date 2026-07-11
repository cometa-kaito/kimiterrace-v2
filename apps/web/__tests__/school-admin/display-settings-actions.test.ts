import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * サイネージ表示設定（提出物の期日表示形式・#1258）Server Action の配線テスト。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は importOriginal で実体を保ちつつ
 * `upsertSchoolConfig` を差し替える（blackout-actions.test と同作法）。既存値の読み取りは
 * fake tx の select チェーンで模し、**FOR UPDATE の行ロック**（#1264・read-merge-write の並行ロスト防止）
 * が掛かることをチェーン記録で固定する。
 *
 * 重点: 入力検証で DB に到達しないこと、school_admin 専任の認可、**相乗りキー（signageDesign /
 * editorDayCutover）を消さないマージ upsert（読み取りは FOR UPDATE）**、制約違反（Drizzle wrap・
 * cause.code）の conflict 写像。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const upsertSchoolConfigMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    upsertSchoolConfig: (...a: unknown[]) => upsertSchoolConfigMock(...a),
  };
});

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { saveAssignmentDeadlineFormatAction } from "../../lib/school-admin/display-settings-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const CONFIG_ID = "44444444-4444-4444-8444-444444444444";

const admin = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };

/** select チェーン（FOR UPDATE 読取）の呼び出し記録。 */
const lockCalls: { forModes: string[] } = { forModes: [] };

/**
 * fake tx。audit_log の .insert(...).values(...) と、既存値読取の
 * .select(...).from(...).where(...).limit(...).for("update") チェーンを満たす。
 * `prevValue` が display_settings 既存行の value（null = 未設定行なし）。
 */
function fakeTx(prevValue: unknown | null = null) {
  return {
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: (mode: string) => {
              lockCalls.forModes.push(mode);
              return Promise.resolve(prevValue === null ? [] : [{ value: prevValue }]);
            },
          }),
        }),
      }),
    }),
  };
}

/** withSession が `prevValue` 入りの fake tx で callback を実行するよう束ねる。 */
function stubSession(prevValue: unknown | null = null) {
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(prevValue), admin))) as typeof withSession);
}

beforeEach(() => {
  vi.clearAllMocks();
  lockCalls.forModes = [];
  requireRoleMock.mockResolvedValue(admin);
  upsertSchoolConfigMock.mockResolvedValue(CONFIG_ID);
  stubSession(null); // 未設定 → insert 分岐
});

describe("saveAssignmentDeadlineFormatAction", () => {
  it("未知の形式は invalid を返し、認可も走らせない", async () => {
    const res = await saveAssignmentDeadlineFormatAction("bogus");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("school_admin は保存でき、value に形式キーが載る（未設定 → insert）", async () => {
    const res = await saveAssignmentDeadlineFormatAction("until");
    expect(res).toEqual({ ok: true, data: { format: "until" } });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
    expect(upsertSchoolConfigMock).toHaveBeenCalledTimes(1);
    expect(upsertSchoolConfigMock.mock.calls[0]?.[1]).toMatchObject({
      schoolId: SCHOOL_ID,
      kind: "display_settings",
      value: { assignmentDeadlineFormat: "until" },
      actorUserId: USER_ID,
    });
  });

  it("既存値の読み取りは FOR UPDATE で行ロックする（並行 read-merge-write のロスト防止・#1264）", async () => {
    await saveAssignmentDeadlineFormatAction("until");
    expect(lockCalls.forModes).toEqual(["update"]);
  });

  it("既存の相乗りキー（signageDesign / editorDayCutover）をロック読取の値からマージし消さない", async () => {
    stubSession({
      signageDesign: "pattern2",
      editorDayCutover: "15:30",
      assignmentDeadlineFormat: "daysLeft",
    });
    const res = await saveAssignmentDeadlineFormatAction("until");
    expect(res).toEqual({ ok: true, data: { format: "until" } });
    expect(lockCalls.forModes).toEqual(["update"]); // マージ基底はロック済みの読取値
    expect(upsertSchoolConfigMock.mock.calls[0]?.[1]).toMatchObject({
      value: {
        signageDesign: "pattern2",
        editorDayCutover: "15:30",
        assignmentDeadlineFormat: "until",
      },
    });
  });

  it("system_admin（テナント外・対象校なし）は forbidden（DB に到達しない）", async () => {
    requireRoleMock.mockResolvedValue({
      uid: USER_ID,
      role: "system_admin" as const,
      schoolId: null,
    });
    const res = await saveAssignmentDeadlineFormatAction("until");
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("制約違反（Drizzle wrap, cause.code=23505）は conflict に写像し 500 化させない", async () => {
    withSessionMock.mockRejectedValue(
      Object.assign(new Error("Failed query: insert into school_configs"), {
        cause: Object.assign(new Error("unique violation"), { code: "23505" }),
      }),
    );
    const res = await saveAssignmentDeadlineFormatAction("until");
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
