import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#324, ADR-026): setMemberActiveAction の配線テスト。next/cache・guard・db・IdP seam を mock。
 *
 * 検証する不変条件:
 * - 入力検証 (uuid / boolean) と **self-guard** は IdP / DB に到達しない。
 * - role 境界: 対象が teacher 以外なら `canDisableAccount` で forbidden (RLS は school 境界しか守らない)。
 * - **IdP を先に、DB mirror を後に** (ADR-026): IdP が失敗したら DB 書き込みに到達しない。
 * - 無効化は `deactivateIdpUser`、再有効化は `reactivateIdpUser` を呼ぶ (排他)。
 * - 監査 (table=users / op=update / school_id=自校 / actor=自分 / diff.before,after の is_active)。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("../../lib/auth/admin-mutations", () => ({
  deactivateIdpUser: vi.fn(),
  reactivateIdpUser: vi.fn(),
}));

import { auditLog } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { deactivateIdpUser, reactivateIdpUser } from "../../lib/auth/admin-mutations";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { setMemberActiveAction } from "../../lib/role-management/member-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);
const deactivateMock = vi.mocked(deactivateIdpUser);
const reactivateMock = vi.mocked(reactivateIdpUser);

const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const ADMIN_UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEACHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const schoolAdmin = { uid: ADMIN_UID, role: "school_admin" as const, schoolId: SCHOOL_ID };

// fakeTx の振る舞いを各テストで差し替えるための状態。
let selectRows: { role: string; isActive: boolean }[];
let updateRows: { id: string }[];
let updateValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;

function fakeTx() {
  return {
    // read: select(...).from(users).where(eq).limit(1)
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectRows) }),
      }),
    }),
    // write: update(users).set(v).where(eq).returning({id})
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateValues = v;
        return { where: () => ({ returning: () => Promise.resolve(updateRows) }) };
      },
    }),
    // audit: insert(auditLog).values(v)
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
  requireRoleMock.mockResolvedValue(schoolAdmin);
  deactivateMock.mockResolvedValue(undefined);
  reactivateMock.mockResolvedValue(undefined);
  selectRows = [{ role: "teacher", isActive: true }];
  updateRows = [{ id: TEACHER_ID }];
  updateValues = null;
  auditValues = null;
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), schoolAdmin))) as typeof withSession);
});

describe("setMemberActiveAction (#324 無効化/再有効化)", () => {
  it("userId が UUID でないと invalid、認可も IdP も DB も走らせない", async () => {
    const res = await setMemberActiveAction({ userId: "not-a-uuid", isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("isActive が boolean でないと invalid", async () => {
    const res = await setMemberActiveAction({ userId: TEACHER_ID, isActive: "false" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を school_admin のみで呼ぶ", async () => {
    await setMemberActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin"]);
  });

  it("非 school_admin は requireRole が redirect (throw) し DB/IdP に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(setMemberActiveAction({ userId: TEACHER_ID, isActive: false })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("self-guard: 自分自身を対象にすると forbidden、IdP/DB に到達しない", async () => {
    const res = await setMemberActiveAction({ userId: ADMIN_UID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it("対象が見つからない (RLS 不可視/不存在) と not_found、IdP を呼ばない", async () => {
    selectRows = [];
    const res = await setMemberActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(deactivateMock).not.toHaveBeenCalled();
    // read tx だけ実行され、write tx には到達しない。
    expect(withSessionMock).toHaveBeenCalledTimes(1);
    expect(updateValues).toBeNull();
  });

  it("対象が teacher 以外 (school_admin) は role 境界で forbidden、IdP を呼ばない", async () => {
    selectRows = [{ role: "school_admin", isActive: true }];
    const res = await setMemberActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(updateValues).toBeNull();
  });

  it("正常系 無効化: IdP deactivate → DB mirror is_active=false + updated_at 明示 → revalidate", async () => {
    selectRows = [{ role: "teacher", isActive: true }];
    const res = await setMemberActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(res).toEqual({ ok: true, data: { id: TEACHER_ID, isActive: false } });
    expect(deactivateMock).toHaveBeenCalledWith(TEACHER_ID);
    expect(reactivateMock).not.toHaveBeenCalled();
    expect(updateValues).toMatchObject({ isActive: false, updatedBy: ADMIN_UID });
    expect(updateValues?.updatedAt).toBeInstanceOf(Date);
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/school/members");
  });

  it("正常系 再有効化: IdP reactivate (revoke なし経路) → DB mirror is_active=true", async () => {
    selectRows = [{ role: "teacher", isActive: false }];
    const res = await setMemberActiveAction({ userId: TEACHER_ID, isActive: true });
    expect(res).toEqual({ ok: true, data: { id: TEACHER_ID, isActive: true } });
    expect(reactivateMock).toHaveBeenCalledWith(TEACHER_ID);
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(updateValues).toMatchObject({ isActive: true });
  });

  it("監査: table=users / op=update / school_id=自校 / actor=自分 / diff.before,after", async () => {
    selectRows = [{ role: "teacher", isActive: true }];
    await setMemberActiveAction({ userId: TEACHER_ID, isActive: false });
    expect(auditValues).toMatchObject({
      actorUserId: ADMIN_UID,
      schoolId: SCHOOL_ID,
      tableName: "users",
      recordId: TEACHER_ID,
      operation: "update",
    });
    expect(auditValues?.diff).toEqual({ before: { isActive: true }, after: { isActive: false } });
  });

  it("ADR-026 順序: IdP が失敗したら DB mirror に到達しない (安全側、旧状態維持)", async () => {
    deactivateMock.mockRejectedValue(new Error("idp down"));
    await expect(setMemberActiveAction({ userId: TEACHER_ID, isActive: false })).rejects.toThrow(
      "idp down",
    );
    // read tx は実行されるが、IdP 失敗で write tx には到達せず DB は書かれない。
    expect(withSessionMock).toHaveBeenCalledTimes(1);
    expect(updateValues).toBeNull();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
