import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * クラス静粛時間 Server Action の配線テスト (#48-J-2)。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は `importOriginal` で実体を保ちつつ、
 * 読み取り / upsert ヘルパ (`findVisibleClass` / `getClassConfigValue` / `upsertClassConfig`) だけ
 * 差し替えて cross-tenant / insert・update 分岐を検証する。`withSession` は callback を fake tx で実行する。
 *
 * 重点: 認可 (QUIET_HOURS_ROLES / forbidden)、cross-tenant classId 拒否、入力検証で DB に到達しないこと、
 * upsert の insert/update に応じた audit operation。
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

import { auditLog } from "@kimiterrace/db";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { saveQuietHoursAction } from "../../lib/school-admin/quiet-hours-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CLASS_ID = "99999999-9999-4999-8999-999999999999";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const CONFIG_ID = "44444444-4444-4444-8444-444444444444";

const admin = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };

const VALID_RANGES = [{ start: "12:00", end: "13:00" }];

/** insert の audit_log 書き込みチェーン (.values) を満たす fake tx。値は capture する。 */
let auditInsertTable: unknown;
let auditValues: unknown;
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
  requireRoleMock.mockResolvedValue(admin);
  findVisibleClassMock.mockResolvedValue({ id: CLASS_ID, name: "1-A" });
  getClassConfigValueMock.mockResolvedValue(null); // 既定: 未設定 → insert 分岐
  upsertClassConfigMock.mockResolvedValue(CONFIG_ID);
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), admin))) as typeof withSession);
});

describe("saveQuietHoursAction", () => {
  it("不正な classId は invalid を返し、認可も走らせない", async () => {
    const res = await saveQuietHoursAction("nope", VALID_RANGES);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("検証 NG (HH:MM でない / start>=end) は DB に到達せず invalid", async () => {
    const bad = await saveQuietHoursAction(CLASS_ID, [{ start: "9:00", end: "10:00" }]);
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid" } });
    const rev = await saveQuietHoursAction(CLASS_ID, [{ start: "13:00", end: "12:00" }]);
    expect(rev).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("QUIET_HOURS_ROLES (school_admin/system_admin) のみ認可する", async () => {
    await saveQuietHoursAction(CLASS_ID, VALID_RANGES);
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("schoolId 無し (テナント未選択) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await saveQuietHoursAction(CLASS_ID, VALID_RANGES);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("cross-tenant: 自校で不可視なクラスは invalid (CrossTenantError 写像)、upsert しない", async () => {
    findVisibleClassMock.mockResolvedValue(null);
    const res = await saveQuietHoursAction(OTHER_CLASS_ID, VALID_RANGES);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(upsertClassConfigMock).not.toHaveBeenCalled();
  });

  it("正常系 (未設定→insert): upsert + audit operation=insert、id を返す", async () => {
    const res = await saveQuietHoursAction(CLASS_ID, VALID_RANGES);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
    expect(upsertClassConfigMock).toHaveBeenCalledTimes(1);
    // school_configs テーブルに対する audit、operation=insert (既存 null)
    expect(auditInsertTable).toBe(auditLog);
    expect(auditValues).toMatchObject({
      tableName: "school_configs",
      operation: "insert",
      recordId: CONFIG_ID,
      schoolId: SCHOOL_ID,
      actorUserId: USER_ID,
    });
  });

  it("正常系 (既存あり→update): audit operation=update", async () => {
    getClassConfigValueMock.mockResolvedValue({ ranges: [{ start: "08:00", end: "09:00" }] });
    const res = await saveQuietHoursAction(CLASS_ID, VALID_RANGES);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
    expect(auditValues).toMatchObject({ operation: "update", tableName: "school_configs" });
  });

  it("正常系: 空配列で静粛時間なしに更新できる", async () => {
    const res = await saveQuietHoursAction(CLASS_ID, []);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
    expect(upsertClassConfigMock).toHaveBeenCalledTimes(1);
  });

  it("upsert の値: kind=quiet_hours / scope='class' を core 経由で結線 (value は {ranges})", async () => {
    await saveQuietHoursAction(CLASS_ID, VALID_RANGES);
    expect(upsertClassConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        schoolId: SCHOOL_ID,
        classId: CLASS_ID,
        kind: "quiet_hours",
        value: { ranges: [{ start: "12:00", end: "13:00" }] },
        actorUserId: USER_ID,
      }),
    );
  });
});
