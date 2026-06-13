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

  it("停止: is_active=false + status=paused を同時 set し、監査に両方を残す (不変条件)", async () => {
    const res = await setAdvertiserActiveAction({ id: ADV_ID, isActive: false });
    expect(res).toEqual({ ok: true, data: { id: ADV_ID, isActive: false } });
    // 停止は is_active=false かつ status=paused を同時に set してズレを防ぐ (PR #534)。
    expect(updateSet).toMatchObject({ isActive: false, status: "paused", updatedBy: null });
    // updated_at を明示更新する (auditColumns は UPDATE で自動更新しないため、ルール1)。
    expect(updateSet?.updatedAt).toBeInstanceOf(Date);
    expect(auditValues).toMatchObject({
      // system_admin は users 行が無いため actor_user_id 等は FK 制約で NULL、しかし実行者は
      // actor_identity_uid に IdP uid を載せて休止/再開の実行者を立証可能にする (ルール1 / NFR04)。
      actorUserId: null,
      actorIdentityUid: SYS_UID,
      createdBy: null,
      updatedBy: null,
      schoolId: null,
      tableName: "advertisers",
      recordId: ADV_ID,
      operation: "update",
    });
    const after = (auditValues?.diff as { after?: { isActive?: boolean; status?: string } })?.after;
    expect(after?.isActive).toBe(false);
    expect(after?.status).toBe("paused");
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/system/advertisers");
  });

  it("再開: is_active=true + status=active を同時 set する (不変条件)", async () => {
    const res = await setAdvertiserActiveAction({ id: ADV_ID, isActive: true });
    expect(res).toEqual({ ok: true, data: { id: ADV_ID, isActive: true } });
    expect(updateSet).toMatchObject({ isActive: true, status: "active" });
    const after = (auditValues?.diff as { after?: { status?: string } })?.after;
    expect(after?.status).toBe("active");
  });
});
