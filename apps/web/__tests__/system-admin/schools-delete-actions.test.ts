import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #48-L4 (#123): deleteSchoolAction の配線テスト。
 *
 * next/cache・guard・db を mock。fakeTx は getSchool (select) / deleteSchool (delete.returning) /
 * audit (insert.values) を提供する。FK 違反 (23503) は drizzle ラップ越し (cause.code) で conflict に
 * 写像されることを確認する。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { deleteSchoolAction } from "../../lib/system-admin/schools-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

let captured: Record<string, unknown>[];
let selectRows: unknown[];
let deleteReturning: unknown[];

function fakeTx() {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(selectRows),
  };
  const deleteChain = {
    where: () => deleteChain,
    returning: () => Promise.resolve(deleteReturning),
  };
  const insertChain = {
    values: (v: Record<string, unknown>) => {
      captured.push(v);
      return Promise.resolve(undefined);
    },
  };
  return {
    select: () => selectChain,
    delete: () => deleteChain,
    insert: () => insertChain,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  captured = [];
  selectRows = [
    {
      id: SCHOOL_ID,
      name: "廃校予定校",
      prefecture: "岐阜県",
      code: "X",
      hierarchyMode: "class",
      notes: "統廃合により2026年度末で閉校",
    },
  ];
  deleteReturning = [{ id: SCHOOL_ID }];
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("deleteSchoolAction", () => {
  it("不正な id は invalid を返し、認可も DB も走らせない", async () => {
    const res = await deleteSchoolAction({ id: "nope" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await deleteSchoolAction({ id: SCHOOL_ID });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("非 system_admin は requireRole が redirect (throw) し DB に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(deleteSchoolAction({ id: SCHOOL_ID })).rejects.toThrow("NEXT_REDIRECT");
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象校が不可視 (getSchool 0 件) は not_found、削除しない", async () => {
    selectRows = [];
    const res = await deleteSchoolAction({ id: SCHOOL_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("DELETE が 0 行は not_found", async () => {
    deleteReturning = [];
    const res = await deleteSchoolAction({ id: SCHOOL_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("FK 違反 (cause.code=23503) は conflict に写像 (子データ残存)", async () => {
    withSessionMock.mockRejectedValue(
      Object.assign(new Error("Failed query: delete from schools"), {
        cause: { code: "23503", message: "violates foreign key constraint" },
      }),
    );
    const res = await deleteSchoolAction({ id: SCHOOL_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("正常系: 削除して id を返す", async () => {
    const res = await deleteSchoolAction({ id: SCHOOL_ID });
    expect(res).toEqual({ ok: true, data: { id: SCHOOL_ID } });
  });

  it("監査: operation=delete / actor 系 NULL / school_id=対象校 id / diff.before", async () => {
    await deleteSchoolAction({ id: SCHOOL_ID });
    const audit = captured.find((v) => v.tableName === "schools");
    expect(audit).toMatchObject({
      actorUserId: null,
      createdBy: null,
      updatedBy: null,
      schoolId: SCHOOL_ID,
      recordId: SCHOOL_ID,
      operation: "delete",
    });
    expect((audit?.diff as { before?: { name?: string } })?.before?.name).toBe("廃校予定校");
  });

  it("監査 before は不可逆削除の立証用に notes を含む (全編集カラム) (#246 Low-1)", async () => {
    await deleteSchoolAction({ id: SCHOOL_ID });
    const audit = captured.find((v) => v.tableName === "schools");
    expect((audit?.diff as { before?: Record<string, unknown> })?.before).toEqual({
      name: "廃校予定校",
      prefecture: "岐阜県",
      code: "X",
      hierarchyMode: "class",
      notes: "統廃合により2026年度末で閉校",
    });
  });

  it("削除後に一覧・詳細・編集ページを revalidate する (stale ページ防止) (#246 Low-3)", async () => {
    await deleteSchoolAction({ id: SCHOOL_ID });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/system/schools");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/admin/system/schools/${SCHOOL_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/admin/system/schools/${SCHOOL_ID}/edit`);
  });
});
