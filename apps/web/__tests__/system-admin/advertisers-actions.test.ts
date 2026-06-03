import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): createAdvertiserAction の配線テスト。next/cache・guard・db を mock。fakeTx は
 * advertisers の insert().values().returning() と audit の insert().values() を提供する。検証失敗・認可・
 * 監査 (school_id/actor NULL, table=advertisers, op=insert) を確認する。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { auditLog } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { createAdvertiserAction } from "../../lib/system-admin/advertisers-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

let advValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;
let returningRows: { id: string }[];

function fakeTx() {
  return {
    // insert 先テーブルの参照で advertisers / audit_log を判別する (thenable ハックを避ける)。
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === auditLog) {
          auditValues = v;
          return Promise.resolve(undefined);
        }
        // advertisers 経路: .returning() で id を返す。
        advValues = v;
        return { returning: () => Promise.resolve(returningRows) };
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  advValues = null;
  auditValues = null;
  returningRows = [{ id: ADV_ID }];
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("createAdvertiserAction", () => {
  it("会社名が空は invalid を返し、認可も DB も走らせない", async () => {
    const res = await createAdvertiserAction({ companyName: "" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await createAdvertiserAction({ companyName: "アクメ商事" });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("非 system_admin は requireRole が redirect (throw) し DB に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(createAdvertiserAction({ companyName: "アクメ商事" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("正常系: 広告主を INSERT し id を返す (status 既定 prospect・is_active 導出・actor NULL)", async () => {
    const res = await createAdvertiserAction({
      companyName: "アクメ商事",
      industry: "広告",
      contactEmail: "sales@acme.example",
    });
    expect(res).toEqual({ ok: true, data: { id: ADV_ID } });
    expect(advValues).toMatchObject({
      companyName: "アクメ商事",
      industry: "広告",
      contactEmail: "sales@acme.example",
      contactPhone: null,
      address: null,
      notes: null,
      // status 未指定は prospect、is_active は status から導出 (prospect → true)。
      status: "prospect",
      isActive: true,
      createdBy: null,
      updatedBy: null,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/admin/system/advertisers");
  });

  it("status=paused で作成すると is_active=false に導出される (不変条件)", async () => {
    await createAdvertiserAction({ companyName: "休止社", status: "paused" });
    expect(advValues).toMatchObject({ status: "paused", isActive: false });
  });

  it("status=active で作成すると is_active=true に導出される", async () => {
    await createAdvertiserAction({ companyName: "契約社", status: "active" });
    expect(advValues).toMatchObject({ status: "active", isActive: true });
  });

  it("不正な status は invalid を返し、認可も DB も走らせない", async () => {
    const res = await createAdvertiserAction({ companyName: "X社", status: "bogus" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("監査: table=advertisers / op=insert / school_id・actor NULL / diff.after", async () => {
    await createAdvertiserAction({ companyName: "アクメ商事" });
    expect(auditValues).toMatchObject({
      actorUserId: null,
      schoolId: null,
      createdBy: null,
      updatedBy: null,
      tableName: "advertisers",
      recordId: ADV_ID,
      operation: "insert",
    });
    const after = (auditValues?.diff as { after?: { companyName?: string; status?: string } })
      ?.after;
    expect(after?.companyName).toBe("アクメ商事");
    expect(after?.status).toBe("prospect");
  });
});
