import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): updateAdvertiserAction の配線テスト。next/cache・guard・db を mock。fakeTx は
 * 更新前 SELECT (before / not_found 検出) → update().set().where().returning() → audit insert を提供する。
 * 不正 id・検証失敗・認可・更新値・監査 (operation=update / diff before+after / school_id・actor NULL)・
 * not_found を確認する。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { updateAdvertiserAction } from "../../lib/system-admin/advertisers-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

const BEFORE_ROW = {
  companyName: "旧社名",
  industry: "旧業種",
  contactEmail: "old@example.com",
  contactPhone: "000",
  address: "旧住所",
  notes: "旧備考",
  status: "prospect" as const,
};

const VALID_INPUT = {
  companyName: "新社名",
  industry: "新業種",
  contactEmail: "new@example.com",
  contactPhone: "111",
  address: "新住所",
  notes: "新備考",
  status: "active" as const,
};

let updateSet: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;
let beforeRows: unknown[];
let updatedRows: { id: string }[];

function fakeTx() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(beforeRows) }),
      }),
    }),
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
  beforeRows = [{ ...BEFORE_ROW }];
  updatedRows = [{ id: ADV_ID }];
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("updateAdvertiserAction", () => {
  it("不正な id は invalid を返し、認可も DB も走らせない", async () => {
    const res = await updateAdvertiserAction("nope", VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("会社名が空だと検証失敗 (invalid) で DB に到達しない", async () => {
    const res = await updateAdvertiserAction(ADV_ID, { ...VALID_INPUT, companyName: "  " });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("メール形式が不正だと invalid で DB に到達しない", async () => {
    const res = await updateAdvertiserAction(ADV_ID, { ...VALID_INPUT, contactEmail: "bad" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES で呼ぶ", async () => {
    await updateAdvertiserAction(ADV_ID, VALID_INPUT);
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("非 system_admin は requireRole が throw し DB に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(updateAdvertiserAction(ADV_ID, VALID_INPUT)).rejects.toThrow("NEXT_REDIRECT");
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("成功時: 全フィールド + status + 導出 is_active + updated_at を更新し、updatedBy は NULL", async () => {
    const res = await updateAdvertiserAction(ADV_ID, VALID_INPUT);
    expect(res).toEqual({ ok: true, data: { id: ADV_ID } });
    expect(updateSet).toMatchObject({
      companyName: "新社名",
      industry: "新業種",
      contactEmail: "new@example.com",
      contactPhone: "111",
      address: "新住所",
      notes: "新備考",
      // status=active なので is_active は導出で true (不変条件)。
      status: "active",
      isActive: true,
      updatedBy: null,
    });
    expect(updateSet?.updatedAt).toBeInstanceOf(Date);
  });

  it("status=paused に編集すると is_active=false に導出される (不変条件)", async () => {
    await updateAdvertiserAction(ADV_ID, { ...VALID_INPUT, status: "paused" });
    expect(updateSet).toMatchObject({ status: "paused", isActive: false });
  });

  it("不正な status は invalid で DB に到達しない", async () => {
    const res = await updateAdvertiserAction(ADV_ID, { ...VALID_INPUT, status: "bogus" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("監査: operation=update / diff は before+after / school_id・actor_user_id は NULL だが actor_identity_uid に IdP uid", async () => {
    await updateAdvertiserAction(ADV_ID, VALID_INPUT);
    expect(auditValues).toMatchObject({
      tableName: "advertisers",
      recordId: ADV_ID,
      operation: "update",
      schoolId: null,
      // system_admin は users 行が無いため actor_user_id 等は FK 制約で NULL、しかし実行者は
      // actor_identity_uid に IdP uid を載せて「誰が」を立証可能にする (ルール1 / NFR04)。
      actorUserId: null,
      actorIdentityUid: SYS_UID,
      createdBy: null,
      updatedBy: null,
      diff: { before: BEFORE_ROW, after: VALID_INPUT },
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/ops/advertisers");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/ops/advertisers/${ADV_ID}/edit`);
  });

  it("対象が不可視 / 不存在 (before 0 行) は not_found、UPDATE を走らせない", async () => {
    beforeRows = [];
    const res = await updateAdvertiserAction(ADV_ID, VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(updateSet).toBeNull();
    expect(auditValues).toBeNull();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("UPDATE が 0 行 (RLS 越境の多層防御) も not_found に倒す", async () => {
    updatedRows = [];
    const res = await updateAdvertiserAction(ADV_ID, VALID_INPUT);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(auditValues).toBeNull();
  });
});
