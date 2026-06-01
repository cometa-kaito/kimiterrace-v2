import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): createContractAction / updateContractStatusAction の配線テスト。next/cache・guard・db を
 * mock。fakeTx は insert().values().returning()、select().from().where().limit()、
 * update().set().where().returning() を提供する。検証失敗・認可 (system_admin)・監査・FK・遷移ガード
 * (許可/不許可/同一/not_found) を確認する。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { auditLog } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  createContractAction,
  updateContractStatusAction,
} from "../../lib/system-admin/contracts-actions";
import type { ContractStatus } from "../../lib/system-admin/contracts-core";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTRACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

let contractValues: Record<string, unknown> | null;
let updateValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;
let returningRows: { id: string }[];
let fkViolation: boolean;
/** select().limit() が返す現在行 (undefined = not_found)。 */
let beforeRow: { status: ContractStatus; advertiserId: string } | undefined;
/** update().returning() が返す行。 */
let updateReturning: { id: string }[];

function fakeTx() {
  return {
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === auditLog) {
          auditValues = v;
          return Promise.resolve(undefined);
        }
        contractValues = v;
        return {
          returning: () =>
            fkViolation ? Promise.reject({ code: "23503" }) : Promise.resolve(returningRows),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(beforeRow === undefined ? [] : [beforeRow]),
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updateValues = v;
        return { where: () => ({ returning: () => Promise.resolve(updateReturning) }) };
      },
    }),
  };
}

function validRaw(over: Record<string, unknown> = {}) {
  return {
    advertiserId: ADV_ID,
    status: "active",
    startedAt: "2026-04-01",
    monthlyFeeJpy: 50000,
    endedAt: "2027-03-31",
    notes: "年度契約",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  contractValues = null;
  updateValues = null;
  auditValues = null;
  returningRows = [{ id: CONTRACT_ID }];
  fkViolation = false;
  beforeRow = { status: "active", advertiserId: ADV_ID };
  updateReturning = [{ id: CONTRACT_ID }];
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("createContractAction", () => {
  it("検証失敗 (status 不正) は invalid を返し、認可も DB も走らせない", async () => {
    const res = await createContractAction(validRaw({ status: "expired" }));
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await createContractAction(validRaw());
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("成功: contracts に正しい値で INSERT し id を返す", async () => {
    const res = await createContractAction(validRaw());
    expect(res).toEqual({ ok: true, data: { id: CONTRACT_ID } });
    expect(contractValues).toMatchObject({
      advertiserId: ADV_ID,
      status: "active",
      monthlyFeeJpy: 50000,
      targetSchools: [],
      notes: "年度契約",
      // system_admin は users 行でないため actor は NULL (ルール1)。
      createdBy: null,
      updatedBy: null,
    });
    expect((contractValues?.startedAt as Date).toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/admin/system/advertisers/${ADV_ID}/edit`);
  });

  it("監査: table=contracts / op=insert / school_id・actor NULL / 日付は ISO 文字列", async () => {
    await createContractAction(validRaw());
    expect(auditValues).toMatchObject({
      actorUserId: null,
      schoolId: null,
      tableName: "contracts",
      recordId: CONTRACT_ID,
      operation: "insert",
      createdBy: null,
      updatedBy: null,
    });
    const after = (auditValues?.diff as { after: Record<string, unknown> }).after;
    expect(after.startedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(after.endedAt).toBe("2027-03-31T00:00:00.000Z");
    expect(after.monthlyFeeJpy).toBe(50000);
  });

  it("存在しない広告主 (FK 23503) は not_found を返す", async () => {
    fkViolation = true;
    const res = await createContractAction(validRaw());
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("updateContractStatusAction", () => {
  it("id が UUID でないと invalid、認可も DB も走らせない", async () => {
    const res = await updateContractStatusAction({ id: "x", status: "paused" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("status が enum 外だと invalid", async () => {
    const res = await updateContractStatusAction({ id: CONTRACT_ID, status: "expired" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES で呼ぶ", async () => {
    await updateContractStatusAction({ id: CONTRACT_ID, status: "paused" });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("許可遷移 (active→paused): status と updated_at を更新し id/status を返す", async () => {
    beforeRow = { status: "active", advertiserId: ADV_ID };
    const res = await updateContractStatusAction({ id: CONTRACT_ID, status: "paused" });
    expect(res).toEqual({ ok: true, data: { id: CONTRACT_ID, status: "paused" } });
    expect(updateValues).toMatchObject({ status: "paused", updatedBy: null });
    // updated_at を明示更新する (ルール1)。
    expect(updateValues?.updatedAt).toBeInstanceOf(Date);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/admin/system/advertisers/${ADV_ID}/edit`);
  });

  it("監査: op=update / diff に before・after の status / school_id・actor NULL", async () => {
    beforeRow = { status: "active", advertiserId: ADV_ID };
    await updateContractStatusAction({ id: CONTRACT_ID, status: "terminated" });
    expect(auditValues).toMatchObject({
      schoolId: null,
      actorUserId: null,
      tableName: "contracts",
      recordId: CONTRACT_ID,
      operation: "update",
    });
    expect(auditValues?.diff).toEqual({
      before: { status: "active" },
      after: { status: "terminated" },
    });
  });

  it("不許可遷移 (terminated→active) は conflict、UPDATE しない", async () => {
    beforeRow = { status: "terminated", advertiserId: ADV_ID };
    const res = await updateContractStatusAction({ id: CONTRACT_ID, status: "active" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(updateValues).toBeNull();
  });

  it("同一ステータスへの no-op (active→active) は conflict", async () => {
    beforeRow = { status: "active", advertiserId: ADV_ID };
    const res = await updateContractStatusAction({ id: CONTRACT_ID, status: "active" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("対象契約が無い (select 0 行) は not_found", async () => {
    beforeRow = undefined;
    const res = await updateContractStatusAction({ id: CONTRACT_ID, status: "paused" });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("読取後に並行遷移 (条件付き UPDATE 0 行) は conflict、監査しない", async () => {
    // SELECT は通る (行は存在) が、status 条件付き UPDATE が 0 行 = 楽観ロック競合。
    beforeRow = { status: "active", advertiserId: ADV_ID };
    updateReturning = [];
    const res = await updateContractStatusAction({ id: CONTRACT_ID, status: "paused" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(auditValues).toBeNull();
  });
});
