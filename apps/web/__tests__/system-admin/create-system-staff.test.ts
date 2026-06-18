import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#508): createSystemStaffAction (system_admin 全校横断 発行) の配線テスト。
 * next/cache・guard・db・IdP seam・observability を mock。
 *
 * 教員アカウント概念の撤去 (2026-06-10): 発行ロールは常に school_admin 固定 (role 入力なし)。教員は学校
 * 共通PW (ADR-032・系統A) でログインし個別アカウントを持たないため、このアクションでは発行しない。
 *
 * 検証する不変条件:
 * - 入力検証 (email / displayName / schoolId uuid) は IdP / DB に到達しない。
 * - **発行ロールは常に school_admin** (入力に依らず固定)。
 * - 対象校が存在しない → notFound、IdP を呼ばない (孤児発行防止)。
 * - **uid 規約 (ADR-003)**: createUser uid == users.id == identity_uid。
 * - **IdP-first** + メール重複 conflict + **DB 失敗で孤児 IdP user を補償削除**。
 * - 監査: table=users / op=insert / **school_id=対象校** / **actor NULL (system_admin)** / diff.after。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));
vi.mock("../../lib/auth/admin-mutations", () => ({
  deactivateIdpUser: vi.fn(),
  reactivateIdpUser: vi.fn(),
  createIdpUser: vi.fn(),
  deleteIdpUser: vi.fn(),
  isEmailAlreadyExistsError: (e: unknown) =>
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "auth/email-already-exists",
}));
vi.mock("@kimiterrace/observability", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  }),
  redactPii: (p: unknown) => p,
  initTracer: vi.fn(),
  withSpan: (_n: unknown, fn: () => unknown) => fn(),
  buildLoggerOptions: vi.fn(),
}));

import { auditLog, users } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { createIdpUser, deleteIdpUser } from "../../lib/auth/admin-mutations";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { createSystemStaffAction } from "../../lib/system-admin/users-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);
const createIdpUserMock = vi.mocked(createIdpUser);
const deleteIdpUserMock = vi.mocked(deleteIdpUser);

const SCHOOL_ID = "55555555-5555-4555-8555-555555555555";
const systemAdmin = { uid: "sysadmin", role: "system_admin" as const, schoolId: null };
const VALID = {
  email: "admin@example.com",
  displayName: "校長先生",
  schoolId: SCHOOL_ID,
};

// fakeTx の差し替え状態。
let schoolRows: { id: string }[];
let usersInsertValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;

function fakeTx() {
  return {
    // school 存在確認: select({id}).from(schools).where(eq).limit(1)
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(schoolRows) }) }),
    }),
    // insert(users|auditLog).values(v)
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === auditLog) auditValues = v;
        else if (table === users) usersInsertValues = v;
        return Promise.resolve(undefined);
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(systemAdmin);
  createIdpUserMock.mockResolvedValue({ setupLink: "https://idp/reset-link" });
  deleteIdpUserMock.mockResolvedValue(undefined);
  schoolRows = [{ id: SCHOOL_ID }];
  usersInsertValues = null;
  auditValues = null;
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), systemAdmin))) as typeof withSession);
});

describe("createSystemStaffAction (#508 system_admin 全校横断発行)", () => {
  it("メール形式が不正なら invalid、IdP/DB に到達しない", async () => {
    const res = await createSystemStaffAction({ ...VALID, email: "bad" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(createIdpUserMock).not.toHaveBeenCalled();
  });

  it("表示名が空なら invalid", async () => {
    const res = await createSystemStaffAction({ ...VALID, displayName: "  " });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(createIdpUserMock).not.toHaveBeenCalled();
  });

  it("schoolId が UUID でないと invalid", async () => {
    const res = await createSystemStaffAction({ ...VALID, schoolId: "not-uuid" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(createIdpUserMock).not.toHaveBeenCalled();
  });

  it("requireRole を system_admin で呼ぶ", async () => {
    await createSystemStaffAction(VALID);
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("対象校が存在しないと notFound、IdP を呼ばない (孤児発行防止)", async () => {
    schoolRows = [];
    const res = await createSystemStaffAction(VALID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(createIdpUserMock).not.toHaveBeenCalled();
  });

  it("正常系 (school_admin): IdP 作成 → DB mirror + 監査 → setupLink + revalidate", async () => {
    const res = await createSystemStaffAction(VALID);
    expect(res).toEqual({
      ok: true,
      data: { id: expect.any(String), setupLink: "https://idp/reset-link" },
    });
    expect(createIdpUserMock.mock.calls[0]?.[0]).toMatchObject({
      email: VALID.email,
      displayName: VALID.displayName,
      role: "school_admin",
      schoolId: SCHOOL_ID,
    });
    // DB mirror: 入力ロール・対象校・system_admin は createdBy NULL。
    expect(usersInsertValues).toMatchObject({
      role: "school_admin",
      email: VALID.email,
      displayName: VALID.displayName,
      isActive: true,
      schoolId: SCHOOL_ID,
      createdBy: null,
    });
    // 監査: actor 系 NULL だが actor_identity_uid に IdP uid / school_id=対象校 / op=insert (#858/#859 同型)。
    expect(auditValues).toMatchObject({
      actorUserId: null,
      actorIdentityUid: systemAdmin.uid,
      schoolId: SCHOOL_ID,
      tableName: "users",
      operation: "insert",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/ops/users");
    expect(deleteIdpUserMock).not.toHaveBeenCalled();
  });

  it("uid 規約 (ADR-003): createUser uid == users.id == identity_uid", async () => {
    const res = await createSystemStaffAction(VALID);
    expect(res.ok).toBe(true);
    const idpUid = createIdpUserMock.mock.calls[0]?.[0]?.uid;
    expect(idpUid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(usersInsertValues?.id).toBe(idpUid);
    expect(usersInsertValues?.identityUid).toBe(idpUid);
  });

  it("role 入力 (teacher 等) は無視され常に school_admin で発行する (教員アカウント概念の撤去)", async () => {
    // 旧 UI を経由しない直接呼び出しで role=teacher を渡しても、アクションは固定で school_admin を発行する。
    await createSystemStaffAction({ ...VALID, role: "teacher" } as Parameters<
      typeof createSystemStaffAction
    >[0]);
    expect(createIdpUserMock.mock.calls[0]?.[0]).toMatchObject({ role: "school_admin" });
    expect(usersInsertValues).toMatchObject({ role: "school_admin" });
  });

  it("メール重複 (auth/email-already-exists) は conflict、DB に到達しない", async () => {
    createIdpUserMock.mockRejectedValue({ code: "auth/email-already-exists" });
    const res = await createSystemStaffAction(VALID);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(usersInsertValues).toBeNull();
    expect(deleteIdpUserMock).not.toHaveBeenCalled();
  });

  it("DB mirror 失敗時は孤児 IdP user を補償削除して throw", async () => {
    // school 確認 (1 回目) は通し、insert (2 回目) で失敗させる。
    let call = 0;
    withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) => {
      call += 1;
      if (call === 1) return Promise.resolve(fn(fakeTx(), systemAdmin));
      return Promise.reject(new Error("db insert failed"));
    }) as typeof withSession);
    await expect(createSystemStaffAction(VALID)).rejects.toThrow("db insert failed");
    const createdUid = createIdpUserMock.mock.calls[0]?.[0]?.uid;
    expect(deleteIdpUserMock).toHaveBeenCalledWith(createdUid);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
