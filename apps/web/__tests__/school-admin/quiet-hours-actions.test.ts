import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 静粛時間 Server Action の配線テスト (#48-J-2、scope 対応版)。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は `importOriginal` で実体を保ちつつ、読み取り / upsert
 * ヘルパ (`findVisibleTarget` / `getScopeConfigValue` / `upsertScopeConfig`) だけ差し替えて cross-tenant /
 * insert・update 分岐を検証する。`withSession` は callback を fake tx で実行する。
 *
 * 重点: 認可 (QUIET_HOURS_ROLES / forbidden)、scope (class/school/grade) 受理、cross-tenant ターゲット拒否、
 * 入力検証で DB に到達しないこと、upsert の insert/update に応じた audit operation、target 列の結線。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const findVisibleTargetMock = vi.fn();
const getScopeConfigValueMock = vi.fn();
const upsertScopeConfigMock = vi.fn();
vi.mock("@kimiterrace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kimiterrace/db")>();
  return {
    ...actual,
    findVisibleTarget: (...a: unknown[]) => findVisibleTargetMock(...a),
    getScopeConfigValue: (...a: unknown[]) => getScopeConfigValueMock(...a),
    upsertScopeConfig: (...a: unknown[]) => upsertScopeConfigMock(...a),
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
const GRADE_ID = "55555555-5555-4555-8555-555555555555";
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
  findVisibleTargetMock.mockResolvedValue({ name: "1-A" });
  getScopeConfigValueMock.mockResolvedValue(null); // 既定: 未設定 → insert 分岐
  upsertScopeConfigMock.mockResolvedValue(CONFIG_ID);
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), admin))) as typeof withSession);
});

describe("saveQuietHoursAction", () => {
  it("不正な targetId (class) は invalid を返し、認可も走らせない", async () => {
    const res = await saveQuietHoursAction("class", "nope", VALID_RANGES);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("不正な scope は invalid", async () => {
    const res = await saveQuietHoursAction("bogus", CLASS_ID, VALID_RANGES);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("検証 NG (HH:MM でない / start>=end) は DB に到達せず invalid", async () => {
    const bad = await saveQuietHoursAction("class", CLASS_ID, [{ start: "9:00", end: "10:00" }]);
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid" } });
    const rev = await saveQuietHoursAction("class", CLASS_ID, [{ start: "13:00", end: "12:00" }]);
    expect(rev).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("QUIET_HOURS_ROLES (school_admin/system_admin) のみ認可する", async () => {
    await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES);
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("schoolId 無し (テナント未選択) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("cross-tenant: 自校で不可視なターゲットは invalid (CrossTenantError 写像)、upsert しない", async () => {
    findVisibleTargetMock.mockResolvedValue(null);
    const res = await saveQuietHoursAction("class", OTHER_CLASS_ID, VALID_RANGES);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(upsertScopeConfigMock).not.toHaveBeenCalled();
  });

  it("正常系 (class, 未設定→insert): upsert + audit operation=insert、id を返す", async () => {
    const res = await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
    expect(upsertScopeConfigMock).toHaveBeenCalledTimes(1);
    // cross-tenant 防御: system_admin 降格 (tenantScoped) で実行する (ADR-019 §#95、ルール2)。
    // schoolId: school_admin は自校 (= 渡しても同値、越境は withSession 側が封じる)。
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: SCHOOL_ID,
    });
    expect(auditInsertTable).toBe(auditLog);
    expect(auditValues).toMatchObject({
      tableName: "school_configs",
      operation: "insert",
      recordId: CONFIG_ID,
      schoolId: SCHOOL_ID,
      // school_admin: actorUserId=uid / created_by,updated_by=uid (userRef) / actorIdentityUid=null。
      actorUserId: USER_ID,
      actorIdentityUid: null,
      createdBy: USER_ID,
      updatedBy: USER_ID,
    });
  });

  it("正常系 (既存あり→update): audit operation=update", async () => {
    getScopeConfigValueMock.mockResolvedValue({ ranges: [{ start: "08:00", end: "09:00" }] });
    const res = await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
    expect(auditValues).toMatchObject({ operation: "update", tableName: "school_configs" });
  });

  it("正常系 (school スコープ, id 不要): upsert して id を返す", async () => {
    const res = await saveQuietHoursAction("school", null, VALID_RANGES);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
  });

  it("正常系 (grade スコープ): upsert して id を返す", async () => {
    const res = await saveQuietHoursAction("grade", GRADE_ID, VALID_RANGES);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
  });

  it("正常系: 空配列で静粛時間なしに更新できる", async () => {
    const res = await saveQuietHoursAction("class", CLASS_ID, []);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
    expect(upsertScopeConfigMock).toHaveBeenCalledTimes(1);
  });

  it("upsert の値: kind=quiet_hours / target=class 列を結線 (value は {ranges})", async () => {
    await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES);
    expect(upsertScopeConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        schoolId: SCHOOL_ID,
        target: { scope: "class", gradeId: null, departmentId: null, classId: CLASS_ID },
        kind: "quiet_hours",
        value: { ranges: [{ start: "12:00", end: "13:00" }] },
        actorUserId: USER_ID,
      }),
    );
  });

  it("upsert の値 (grade スコープ): target=grade 列を結線", async () => {
    await saveQuietHoursAction("grade", GRADE_ID, VALID_RANGES);
    expect(upsertScopeConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: { scope: "grade", gradeId: GRADE_ID, departmentId: null, classId: null },
        kind: "quiet_hours",
      }),
    );
  });

  it("school_admin が targetSchoolId(他校) を渡しても自校に固定する (越境不可)", async () => {
    const OTHER_SCHOOL = "abababab-abab-4bab-8bab-abababababab";
    const res = await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES, OTHER_SCHOOL);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
    // toQuietHoursActor が tenant ロールの targetSchoolId を無視し自校固定 → withSession も自校 schoolId。
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: SCHOOL_ID,
    });
  });
});

/**
 * system_admin が /ops/schools/[id]/quiet-hours/[classId] から特定校を対象に編集する経路の配線
 * (ads-actions.test.ts の対応ブロックと同型)。actor が system_admin (session schoolId=null) のとき、
 * 渡した `targetSchoolId` が `withSession(..., { tenantScoped: true, schoolId })` へ伝播し、
 * created_by/updated_by (userRef) は null (FK 回避)・actorIdentityUid に uid が載ることを固定する。
 * 実際の越境封じ (override は system_admin のみ honor / 降格 RLS) は packages/db の実 PG テストで担保する。
 */
describe("system_admin: 対象校スコープの配線", () => {
  const SYS_UID = "77777777-7777-4777-8777-777777777777";
  const TARGET = "88888888-8888-4888-8888-888888888888";

  beforeEach(() => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
  });

  it("対象校未指定は forbidden、DB に到達しない", async () => {
    const res = await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES);
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象校指定で withSession に { tenantScoped, schoolId: TARGET } を渡す", async () => {
    const res = await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES, TARGET);
    expect(res).toEqual({ ok: true, data: { id: CONFIG_ID } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: TARGET,
    });
  });

  it("audit/upsert の FK 値: created_by/updated_by(userRef)=null・actorIdentityUid=uid・actorUserId=uid", async () => {
    await saveQuietHoursAction("class", CLASS_ID, VALID_RANGES, TARGET);
    // upsert の actorUserId (= created_by/updated_by FK) は null (system_admin は users 行を持たない)。
    expect(upsertScopeConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ schoolId: TARGET, actorUserId: null, kind: "quiet_hours" }),
    );
    // audit_log: actor_user_id=acting uid / created_by,updated_by=null / actor_identity_uid=uid。
    expect(auditValues).toMatchObject({
      schoolId: TARGET,
      actorUserId: SYS_UID,
      actorIdentityUid: SYS_UID,
      createdBy: null,
      updatedBy: null,
    });
  });
});
