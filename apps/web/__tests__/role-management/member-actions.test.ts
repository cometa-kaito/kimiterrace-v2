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
  createIdpUser: vi.fn(),
  deleteIdpUser: vi.fn(),
  generateSetupLinkForExistingUser: vi.fn(),
  // 純関数は実装相当を提供 (conflict 経路を決定的にする)。
  isEmailAlreadyExistsError: (e: unknown) =>
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "auth/email-already-exists",
}));

import { auditLog, users } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import {
  createIdpUser,
  deactivateIdpUser,
  deleteIdpUser,
  generateSetupLinkForExistingUser,
  reactivateIdpUser,
} from "../../lib/auth/admin-mutations";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  createStaffAction,
  reissueStaffSetupLinkAction,
  setMemberActiveAction,
} from "../../lib/role-management/member-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);
const deactivateMock = vi.mocked(deactivateIdpUser);
const reactivateMock = vi.mocked(reactivateIdpUser);
const createIdpUserMock = vi.mocked(createIdpUser);
const deleteIdpUserMock = vi.mocked(deleteIdpUser);
const generateSetupLinkMock = vi.mocked(generateSetupLinkForExistingUser);

const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const ADMIN_UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEACHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const schoolAdmin = { uid: ADMIN_UID, role: "school_admin" as const, schoolId: SCHOOL_ID };

// fakeTx の振る舞いを各テストで差し替えるための状態。
let selectRows: { role: string; isActive: boolean; email?: string | null }[];
let updateRows: { id: string }[];
let updateValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;
let usersInsertValues: Record<string, unknown> | null;

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
    // write/audit: insert(users|auditLog).values(v)
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === auditLog) {
          auditValues = v;
        } else if (table === users) {
          usersInsertValues = v;
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
  createIdpUserMock.mockResolvedValue({ setupLink: "https://idp/reset-link" });
  deleteIdpUserMock.mockResolvedValue(undefined);
  generateSetupLinkMock.mockResolvedValue({
    setupLink: "https://app.example/reset-password?oobCode=REISSUED",
  });
  selectRows = [{ role: "teacher", isActive: true }];
  updateRows = [{ id: TEACHER_ID }];
  updateValues = null;
  auditValues = null;
  usersInsertValues = null;
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

describe("createStaffAction (#508 新規 teacher 発行)", () => {
  const VALID = { email: "teacher@example.com", displayName: "山田先生" };

  it("メール形式が不正なら invalid、IdP/DB に到達しない", async () => {
    const res = await createStaffAction({ email: "not-an-email", displayName: "先生" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(createIdpUserMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("表示名が空なら invalid", async () => {
    const res = await createStaffAction({ email: VALID.email, displayName: "   " });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(createIdpUserMock).not.toHaveBeenCalled();
  });

  it("requireRole を school_admin のみで呼ぶ", async () => {
    await createStaffAction(VALID);
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin"]);
  });

  it("非 school_admin は requireRole が redirect (throw) し IdP/DB に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(createStaffAction(VALID)).rejects.toThrow("NEXT_REDIRECT");
    expect(createIdpUserMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("正常系: IdP 作成 (teacher 固定) → DB mirror + 監査 → setupLink 返却 + revalidate", async () => {
    const res = await createStaffAction(VALID);
    expect(res).toEqual({
      ok: true,
      data: { id: expect.any(String), setupLink: "https://idp/reset-link" },
    });
    // IdP は teacher 固定・自校で作成。
    const idpArgs = createIdpUserMock.mock.calls[0]?.[0];
    expect(idpArgs).toMatchObject({
      email: VALID.email,
      displayName: VALID.displayName,
      role: "teacher",
      schoolId: SCHOOL_ID,
    });
    // DB mirror: role=teacher / email / displayName / isActive=true / 自校。
    expect(usersInsertValues).toMatchObject({
      role: "teacher",
      email: VALID.email,
      displayName: VALID.displayName,
      isActive: true,
      schoolId: SCHOOL_ID,
      createdBy: ADMIN_UID,
    });
    // 監査: table=users / op=insert / 自校 / actor=自分 / diff.after。
    expect(auditValues).toMatchObject({
      actorUserId: ADMIN_UID,
      schoolId: SCHOOL_ID,
      tableName: "users",
      operation: "insert",
    });
    expect((auditValues?.diff as { after?: unknown })?.after).toMatchObject({ role: "teacher" });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/school/members");
    // 補償削除は呼ばれない (成功)。
    expect(deleteIdpUserMock).not.toHaveBeenCalled();
  });

  it("uid 規約 (ADR-003): createUser の uid == users.id == identity_uid に揃える", async () => {
    const res = await createStaffAction(VALID);
    expect(res.ok).toBe(true);
    const idpUid = createIdpUserMock.mock.calls[0]?.[0]?.uid;
    expect(idpUid).toMatch(/^[0-9a-f-]{36}$/i);
    // localId == users.id == identity_uid (作成アカウントを既存 seam で操作可能にする規約)。
    expect(usersInsertValues?.id).toBe(idpUid);
    expect(usersInsertValues?.identityUid).toBe(idpUid);
    if (res.ok) expect(res.data.id).toBe(idpUid);
  });

  it("メール重複 (auth/email-already-exists) は conflict、DB に到達しない", async () => {
    createIdpUserMock.mockRejectedValue({ code: "auth/email-already-exists" });
    const res = await createStaffAction(VALID);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(deleteIdpUserMock).not.toHaveBeenCalled();
  });

  it("不明な IdP エラーは握らず throw (半端な作成を残さない)", async () => {
    createIdpUserMock.mockRejectedValue(new Error("idp down"));
    await expect(createStaffAction(VALID)).rejects.toThrow("idp down");
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("DB mirror 失敗時は孤児 IdP user を補償削除 (deleteIdpUser) して throw", async () => {
    withSessionMock.mockImplementationOnce((() =>
      Promise.reject(new Error("db insert failed"))) as typeof withSession);
    await expect(createStaffAction(VALID)).rejects.toThrow("db insert failed");
    // IdP 作成済の孤児を補償削除。削除対象 uid は作成した uid と一致。
    const createdUid = createIdpUserMock.mock.calls[0]?.[0]?.uid;
    expect(deleteIdpUserMock).toHaveBeenCalledWith(createdUid);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("reissueStaffSetupLinkAction (#324 follow-up B1 設定リンク再発行)", () => {
  it("userId が UUID でないと invalid、認可も IdP も DB も走らせない", async () => {
    const res = await reissueStaffSetupLinkAction({ userId: "not-a-uuid" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(generateSetupLinkMock).not.toHaveBeenCalled();
  });

  it("requireRole を school_admin のみで呼ぶ", async () => {
    selectRows = [{ role: "teacher", isActive: true, email: "t@example.com" }];
    await reissueStaffSetupLinkAction({ userId: TEACHER_ID });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin"]);
  });

  it("非 school_admin は requireRole が redirect (throw) し DB/IdP に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(reissueStaffSetupLinkAction({ userId: TEACHER_ID })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(withSessionMock).not.toHaveBeenCalled();
    expect(generateSetupLinkMock).not.toHaveBeenCalled();
  });

  it("対象が見つからない (RLS 不可視/不存在) と not_found、IdP を呼ばない", async () => {
    selectRows = [];
    const res = await reissueStaffSetupLinkAction({ userId: TEACHER_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(generateSetupLinkMock).not.toHaveBeenCalled();
    // read tx だけ実行され、監査 tx には到達しない。
    expect(withSessionMock).toHaveBeenCalledTimes(1);
    expect(auditValues).toBeNull();
  });

  it("対象が teacher 以外 (school_admin/自分) は role 境界で forbidden、IdP を呼ばない", async () => {
    selectRows = [{ role: "school_admin", isActive: true, email: "admin@example.com" }];
    const res = await reissueStaffSetupLinkAction({ userId: ADMIN_UID });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(generateSetupLinkMock).not.toHaveBeenCalled();
    expect(auditValues).toBeNull();
  });

  it("無効化済みアカウントは conflict (再有効化を促す)、IdP を呼ばない", async () => {
    selectRows = [{ role: "teacher", isActive: false, email: "t@example.com" }];
    const res = await reissueStaffSetupLinkAction({ userId: TEACHER_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(generateSetupLinkMock).not.toHaveBeenCalled();
    expect(withSessionMock).toHaveBeenCalledTimes(1);
  });

  it("email 未登録 (mirror 欠落) は conflict、IdP を呼ばない", async () => {
    selectRows = [{ role: "teacher", isActive: true, email: null }];
    const res = await reissueStaffSetupLinkAction({ userId: TEACHER_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(generateSetupLinkMock).not.toHaveBeenCalled();
  });

  it("正常系: read → (read tx の外で) IdP リンク生成 → 監査 → setupLink 返却", async () => {
    selectRows = [{ role: "teacher", isActive: true, email: "teacher@example.com" }];
    const res = await reissueStaffSetupLinkAction({ userId: TEACHER_ID });
    expect(res).toEqual({
      ok: true,
      data: { id: TEACHER_ID, setupLink: "https://app.example/reset-password?oobCode=REISSUED" },
    });
    // 対象 email でリンク生成 (createStaffAction と共有の seam)。
    expect(generateSetupLinkMock).toHaveBeenCalledWith("teacher@example.com");
    // read tx + 監査 tx の 2 回。リンク生成はその間 (read tx の外)。
    expect(withSessionMock).toHaveBeenCalledTimes(2);
    // 状態変更は無いので revalidate しない。
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("監査: table=users / op=update / 自校 / actor=自分。生のリンク・email は焼き込まない (ルール5/4)", async () => {
    selectRows = [{ role: "teacher", isActive: true, email: "teacher@example.com" }];
    await reissueStaffSetupLinkAction({ userId: TEACHER_ID });
    expect(auditValues).toMatchObject({
      actorUserId: ADMIN_UID,
      schoolId: SCHOOL_ID,
      tableName: "users",
      recordId: TEACHER_ID,
      operation: "update",
    });
    expect(auditValues?.diff).toEqual({ action: "reissue_setup_link" });
    // secret (oobCode 入りリンク) と PII (email) が監査値に一切現れないこと。
    const serialized = JSON.stringify(auditValues);
    expect(serialized).not.toContain("REISSUED");
    expect(serialized).not.toContain("reset-password");
    expect(serialized).not.toContain("teacher@example.com");
  });

  it("IdP 失敗は read tx の外で起き、監査に到達しない (throw 伝播・安全側)", async () => {
    selectRows = [{ role: "teacher", isActive: true, email: "teacher@example.com" }];
    generateSetupLinkMock.mockRejectedValue(new Error("idp down"));
    await expect(reissueStaffSetupLinkAction({ userId: TEACHER_ID })).rejects.toThrow("idp down");
    // read tx は実行されるが、IdP 失敗で監査 tx には到達しない。
    expect(withSessionMock).toHaveBeenCalledTimes(1);
    expect(auditValues).toBeNull();
  });
});
