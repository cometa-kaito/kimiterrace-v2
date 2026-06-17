import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * サイネージ黒画面トグル Server Action の配線テスト。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は importOriginal で実体を保ちつつ
 * `findVisibleClass` / `getClassConfigValue` / `upsertClassConfig` を差し替える。`withSession` は
 * callback を fake tx で実行する。`toEditorActor`(schedule-core) / `parseBlackout` は実体を通す。
 *
 * 重点: 入力検証で DB に到達しないこと、EDITOR_ROLES 認可、正常 upsert、そして **制約違反（Drizzle が
 * SQLSTATE を cause.code へ移した本番同形）が conflict に写像され全画面 500 化しないこと**（#1019 と同根）。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const findVisibleClassMock = vi.fn();
const getClassConfigValueMock = vi.fn();
const upsertClassConfigMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    findVisibleClass: (...a: unknown[]) => findVisibleClassMock(...a),
    getClassConfigValue: (...a: unknown[]) => getClassConfigValueMock(...a),
    upsertClassConfig: (...a: unknown[]) => upsertClassConfigMock(...a),
  };
});

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { setClassSignageBlackoutAction } from "../../lib/signage/blackout-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const CONFIG_ID = "44444444-4444-4444-8444-444444444444";

const admin = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };

/** audit_log の .insert(...).values(...) を満たす fake tx。 */
function fakeTx() {
  return { insert: () => ({ values: () => Promise.resolve(undefined) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(admin);
  findVisibleClassMock.mockResolvedValue({ id: CLASS_ID });
  getClassConfigValueMock.mockResolvedValue(null); // 未設定 → insert 分岐
  upsertClassConfigMock.mockResolvedValue(CONFIG_ID);
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), admin))) as typeof withSession);
});

describe("setClassSignageBlackoutAction", () => {
  it("不正な classId は invalid を返し、認可も走らせない", async () => {
    const res = await setClassSignageBlackoutAction("nope", true);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("blackout が boolean でなければ invalid（DB に到達しない）", async () => {
    const res = await setClassSignageBlackoutAction(CLASS_ID, "yes");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("EDITOR_ROLES (school_admin/teacher) で認可し、正常系は upsert して blackout を返す", async () => {
    const res = await setClassSignageBlackoutAction(CLASS_ID, true);
    expect(res).toEqual({ ok: true, data: { blackout: true } });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "teacher"]);
    expect(upsertClassConfigMock).toHaveBeenCalledTimes(1);
  });

  it("制約違反（Drizzle wrap, cause.code=23505）は conflict に写像し 500 化させない", async () => {
    // 本番同形: Drizzle は SQLSTATE を cause.code へ移す。top-level だけ見る旧実装は取りこぼし
    // 全画面 500 を招いた（#1019）。action の catch が isConstraintViolation→conflict に倒す。
    withSessionMock.mockRejectedValue(
      Object.assign(new Error("Failed query: insert into school_configs"), {
        cause: Object.assign(new Error("unique violation"), { code: "23505" }),
      }),
    );
    const res = await setClassSignageBlackoutAction(CLASS_ID, true);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
