import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): setAdvertiserActiveAction の配線テスト。next/cache・guard・db を mock。fakeTx は
 * advertisers の update().set().where().returning() と audit の insert().values() を提供する。
 * 検証失敗・認可・更新値・監査 (operation=update / school_id・actor NULL) ・not_found を確認する。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { setAdvertiserActiveAction } from "../../lib/system-admin/advertisers-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

let updateSet: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;
let updatedRows: { id: string }[];

function fakeTx() {
  return {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateSet = v;
        return { where: () => ({ returning: () => Promise.resolve(updatedRows) }) };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        auditValues = v;
        return Promise.resolve(undefined);
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  updateSet = null;
  auditValues = null;
  updatedRows = [{ id: ADV_ID }];
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("setAdvertiserActiveAction", () => {
  it("不正な id は invalid を返し、認可も DB も走らせない", async () => {
    const res = await setAdvertiserActiveAction({ id: "nope", isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("isActive が boolean でないと invalid", async () => {
    const res = await setAdvertiserActiveAction({ id: ADV_ID, isActive: "false" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES で呼ぶ", async () => {
    await setAdvertiserActiveAction({ id: ADV_ID, isActive: false });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("非 system_admin は requireRole が throw し DB に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(setAdvertiserActiveAction({ id: ADV_ID, isActive: false })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象が不可視 (UPDATE 0 行) は not_found", async () => {
    updatedRows = [];
    const res = await setAdvertiserActiveAction({ id: ADV_ID, isActive: false });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: is_active を更新し、監査 operation=update / school_id・actor NULL を残す", async () => {
    const res = await setAdvertiserActiveAction({ id: ADV_ID, isActive: false });
    expect(res).toEqual({ ok: true, data: { id: ADV_ID, isActive: false } });
    expect(updateSet).toMatchObject({ isActive: false, updatedBy: null });
    expect(auditValues).toMatchObject({
      actorUserId: null,
      schoolId: null,
      tableName: "advertisers",
      recordId: ADV_ID,
      operation: "update",
    });
    expect((auditValues?.diff as { after?: { isActive?: boolean } })?.after?.isActive).toBe(false);
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/system/advertisers");
  });
});
