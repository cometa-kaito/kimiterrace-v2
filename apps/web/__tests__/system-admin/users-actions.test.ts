import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324, ADR-026): setStaffActiveAction (system_admin 全校横断 無効化/再有効化) の配線テスト。
 * next/cache・guard・db・IdP seam を mock。
 *
 * 検証する不変条件:
 * - 入力検証 (uuid / boolean) は IdP / DB に到達しない。
 * - 教職員以外 (student/guardian) は forbidden。
 * - **last-admin ガード**: 学校で唯一の有効な school_admin の無効化は conflict (IdP を呼ばない)。
 *   有効管理者が複数なら通る。teacher / 再有効化はガード対象外。
 * - **last-admin TOCTOU 根治 (#355 Low-2)**: gate を通過しても mirror tx の FOR UPDATE 再カウントが
 *   最後の 1 人を検出したら、IdP を補償 (再有効化 / ロール復元) して conflict を返し、DB mirror は未更新。
 * - **IdP-first 順序** (ADR-026): IdP が失敗したら DB mirror に到達しない。
 * - 監査: table=users / op=update / **school_id=対象校** / **actor NULL (system_admin)** / diff before-after。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("../../lib/auth/admin-mutations", () => ({
  deactivateIdpUser: vi.fn(),
  reactivateIdpUser: vi.fn(),
  changeIdpUserRole: vi.fn(),
}));

import { auditLog } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import {
  changeIdpUserRole,
  deactivateIdpUser,
  reactivateIdpUser,
} from "../../lib/auth/admin-mutations";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { changeStaffRoleAction, setStaffActiveAction } from "../../lib/system-admin/users-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);
const deactivateMock = vi.mocked(deactivateIdpUser);
const reactivateMock = vi.mocked(reactivateIdpUser);
const changeRoleMock = vi.mocked(changeIdpUserRole);

const SYS_UID = "99999999-9999-4999-8999-999999999999";
const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const TEACHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

// fakeTx の振る舞いを各テストで差し替える状態。
let targetRow: { role: string; isActive: boolean; schoolId: string } | undefined;
let activeAdminCount: number; // gate の last-admin count(*) 戻り値 (lock 無し)
let lockedAdminCount: number | null; // mirror tx の FOR UPDATE 再カウント (#355)。null なら activeAdminCount を流用。
let updateRows: { id: string }[];
let updateValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;

function fakeTx() {
  return {
    // where() の戻り値を 3 つの呼び出し形に同時対応させる (drizzle の thenable query builder を模す):
    //  - gate の last-admin count: select({n}).from().where() を直接 await → [{ n: activeAdminCount }]
    //  - 対象取得: select({...}).from().where().limit(1) → [targetRow]
    //  - mirror tx の TOCTOU 再カウント: select({id}).from().where().for("update") → lockedAdminCount 行
    select: () => ({
      from: () => ({
        where: (..._a: unknown[]) =>
          Object.assign(Promise.resolve([{ n: activeAdminCount }]), {
            limit: () => Promise.resolve(targetRow ? [targetRow] : []),
            for: (..._f: unknown[]) =>
              Promise.resolve(
                Array.from({ length: lockedAdminCount ?? activeAdminCount }, (_v, i) => ({
                  id: `admin-${i}`,
                })),
              ),
          }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateValues = v;
        return { where: () => ({ returning: () => Promise.resolve(updateRows) }) };
      },
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === auditLog) {
          auditValues = v;
        }
        return Promise.resolve(undefined);
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  deactivateMock.mockResolvedValue(undefined);
  reactivateMock.mockResolvedValue(undefined);
  changeRoleMock.mockResolvedValue(undefined);
  targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
  activeAdminCount = 2;
  lockedAdminCount = null;
  updateRows = [{ id: TEACHER_ID }];
  updateValues = null;
  auditValues = null;
  // 各 withSession 呼び出しに新しい fakeTx を渡す (read tx と write tx で select カウンタを分ける)。
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("setStaffActiveAction (#324 system_admin 全校無効化)", () => {
  it("userId が UUID でないと invalid、認可も IdP も DB も走らせない", async () => {
    const res = await setStaffActiveAction({ userId: "nope", isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("isActive が boolean でないと invalid", async () => {
    const res = await setStaffActiveAction({ userId: TEACHER_ID, isActive: 1 });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("非 system_admin は requireRole が redirect (throw) し DB/IdP に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(setStaffActiveAction({ userId: TEACHER_ID, isActive: false })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象が見つからないと not_found、IdP を呼ばない", async () => {
    targetRow = undefined;
    const res = await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });

  it("対象が教職員以外 (student) は forbidden、IdP を呼ばない", async () => {
    targetRow = { role: "student", isActive: true, schoolId: SCHOOL_ID };
    const res = await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("last-admin ガード: 学校で唯一の有効な school_admin の無効化は conflict、IdP を呼ばない", async () => {
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 1; // 自分しか有効な管理者がいない
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });

  it("有効な school_admin が複数なら無効化できる (last-admin ガード通過)", async () => {
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 2;
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(res).toEqual({ ok: true, data: { id: ADMIN_ID, isActive: false } });
    expect(deactivateMock).toHaveBeenCalledWith(ADMIN_ID);
  });

  it("TOCTOU レース (#355 Low-2): gate 通過後 mirror tx の FOR UPDATE 再カウントが最後の 1 人を検出 → IdP 補償 + conflict", async () => {
    // gate は lock 無し count=2 で通過するが、並行無効化が間に commit され mirror tx の FOR UPDATE
    // 再カウントは 1 を返す (= この無効化で学校が管理者ゼロになる)。
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 2;
    lockedAdminCount = 1;
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    // IdP revoke は ADR-026 IdP-first ゆえ確定済 → 補償で再有効化される。
    expect(deactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    expect(reactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    // mirror tx は番兵でロールバック: UPDATE / 監査に到達せず revalidate もしない。
    expect(updateValues).toBeNull();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("school_admin の再有効化は last-admin ガード対象外 (count を見ずに通る)", async () => {
    targetRow = { role: "school_admin", isActive: false, schoolId: SCHOOL_ID };
    activeAdminCount = 0;
    const res = await setStaffActiveAction({ userId: ADMIN_ID, isActive: true });
    expect(res).toEqual({ ok: true, data: { id: ADMIN_ID, isActive: true } });
    expect(reactivateMock).toHaveBeenCalledWith(ADMIN_ID);
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("正常系 無効化: IdP deactivate → DB mirror is_active=false + updated_at 明示 → revalidate", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    const res = await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toEqual({ ok: true, data: { id: TEACHER_ID, isActive: false } });
    expect(deactivateMock).toHaveBeenCalledWith(TEACHER_ID);
    expect(updateValues).toMatchObject({ isActive: false, updatedBy: null });
    expect(updateValues?.updatedAt).toBeInstanceOf(Date);
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/system/users");
  });

  it("監査: table=users / op=update / school_id=対象校 / actor NULL (system_admin) / diff before-after", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    await setStaffActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(auditValues).toMatchObject({
      actorUserId: null,
      schoolId: SCHOOL_ID,
      createdBy: null,
      updatedBy: null,
      tableName: "users",
      recordId: TEACHER_ID,
      operation: "update",
    });
    expect(auditValues?.diff).toEqual({ before: { isActive: true }, after: { isActive: false } });
  });

  it("ADR-026 順序: IdP が失敗したら DB mirror に到達しない (安全側)", async () => {
    deactivateMock.mockRejectedValue(new Error("idp down"));
    await expect(setStaffActiveAction({ userId: TEACHER_ID, isActive: false })).rejects.toThrow(
      "idp down",
    );
    expect(updateValues).toBeNull();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("changeStaffRoleAction (#324 ADR-026 D2 ロール変更)", () => {
  it("nextRole が school_admin/teacher 以外は invalid、認可も IdP も DB も走らせない", async () => {
    const res = await changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "system_admin" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it("userId が UUID でないと invalid", async () => {
    const res = await changeStaffRoleAction({ userId: "nope", nextRole: "teacher" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES で呼ぶ", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    await changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "school_admin" });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("対象が見つからないと not_found、IdP を呼ばない", async () => {
    targetRow = undefined;
    const res = await changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "school_admin" });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it("対象が教職員以外 (student) は forbidden", async () => {
    targetRow = { role: "student", isActive: true, schoolId: SCHOOL_ID };
    const res = await changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "teacher" });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it("現ロールと同じ (teacher→teacher) は no-op の invalid、IdP/DB を走らせない", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    const res = await changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "teacher" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(changeRoleMock).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });

  it("降格 last-admin ガード: 学校で唯一の有効な school_admin の teacher 降格は conflict、IdP を呼ばない", async () => {
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 1;
    const res = await changeStaffRoleAction({ userId: ADMIN_ID, nextRole: "teacher" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(changeRoleMock).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });

  it("有効な school_admin が複数なら teacher へ降格できる (ガード通過)", async () => {
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 2;
    const res = await changeStaffRoleAction({ userId: ADMIN_ID, nextRole: "teacher" });
    expect(res).toEqual({ ok: true, data: { id: ADMIN_ID, role: "teacher" } });
    expect(changeRoleMock).toHaveBeenCalledWith(ADMIN_ID, "teacher", SCHOOL_ID);
  });

  it("TOCTOU レース (#355 Low-2): 降格 gate 通過後 mirror tx 再カウントが最後の 1 人を検出 → IdP ロール復元 + conflict", async () => {
    targetRow = { role: "school_admin", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 2; // gate 通過
    lockedAdminCount = 1; // 並行降格が間に commit
    const res = await changeStaffRoleAction({ userId: ADMIN_ID, nextRole: "teacher" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    // 1 回目=降格 (確定済) → 2 回目=補償で school_admin へ復元。
    expect(changeRoleMock).toHaveBeenNthCalledWith(1, ADMIN_ID, "teacher", SCHOOL_ID);
    expect(changeRoleMock).toHaveBeenNthCalledWith(2, ADMIN_ID, "school_admin", SCHOOL_ID);
    expect(updateValues).toBeNull();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("昇格 teacher→school_admin は last-admin ガード対象外 (count を見ずに通る)", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    activeAdminCount = 0;
    const res = await changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "school_admin" });
    expect(res).toEqual({ ok: true, data: { id: TEACHER_ID, role: "school_admin" } });
    expect(changeRoleMock).toHaveBeenCalledWith(TEACHER_ID, "school_admin", SCHOOL_ID);
  });

  it("正常系 昇格: IdP claims 再付与 → DB mirror role + updated_at 明示 → revalidate", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    await changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "school_admin" });
    expect(changeRoleMock).toHaveBeenCalledWith(TEACHER_ID, "school_admin", SCHOOL_ID);
    expect(updateValues).toMatchObject({ role: "school_admin", updatedBy: null });
    expect(updateValues?.updatedAt).toBeInstanceOf(Date);
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/system/users");
  });

  it("監査: table=users / op=update / school_id=対象校 / actor NULL / diff role before-after", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    await changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "school_admin" });
    expect(auditValues).toMatchObject({
      actorUserId: null,
      schoolId: SCHOOL_ID,
      createdBy: null,
      updatedBy: null,
      tableName: "users",
      recordId: TEACHER_ID,
      operation: "update",
    });
    expect(auditValues?.diff).toEqual({
      before: { role: "teacher" },
      after: { role: "school_admin" },
    });
  });

  it("ADR-026 順序: IdP が失敗したら DB mirror に到達しない (安全側)", async () => {
    targetRow = { role: "teacher", isActive: true, schoolId: SCHOOL_ID };
    changeRoleMock.mockRejectedValue(new Error("idp down"));
    await expect(
      changeStaffRoleAction({ userId: TEACHER_ID, nextRole: "school_admin" }),
    ).rejects.toThrow("idp down");
    expect(updateValues).toBeNull();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
