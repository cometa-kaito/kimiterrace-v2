import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): linkContentToContractAction / unlinkContentFromContractAction の配線テスト。
 * next/cache・guard・db を mock。fakeTx は insert().values().returning()、
 * select().from().where().limit()、delete().where().returning() を提供する。
 * 検証 (UUID)・認可 (system_admin)・監査 (table=contract_contents / NULL school・actor / insert・delete)・
 * UNIQUE 重複 (23505→conflict)・FK (23503→not_found)・unlink の not_found を確認する。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { auditLog } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  linkContentToContractAction,
  unlinkContentFromContractAction,
} from "../../lib/system-admin/contract-contents-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);
const revalidatePathMock = vi.mocked(revalidatePath);

const CONTRACT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTENT_ID = "11111111-1111-4111-8111-111111111111";
const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINK_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

let insertValues: Record<string, unknown> | null;
let auditValues: Record<string, unknown> | null;
let insertReturning: { id: string }[];
let uniqueViolation: boolean;
let fkViolation: boolean;
/** unlink: select().limit() が返す解除前の行 (undefined = not_found)。 */
let beforeRow: Record<string, unknown> | undefined;
/** unlink: delete().returning() が返す行。 */
let deleteReturning: { id: string }[];

function fakeTx() {
  return {
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (table === auditLog) {
          auditValues = v;
          return Promise.resolve(undefined);
        }
        insertValues = v;
        return {
          returning: () => {
            if (uniqueViolation) return Promise.reject({ code: "23505" });
            if (fkViolation) return Promise.reject({ code: "23503" });
            return Promise.resolve(insertReturning);
          },
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
    delete: () => ({
      where: () => ({ returning: () => Promise.resolve(deleteReturning) }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  insertValues = null;
  auditValues = null;
  insertReturning = [{ id: LINK_ID }];
  uniqueViolation = false;
  fkViolation = false;
  beforeRow = { contractId: CONTRACT_ID, contentId: CONTENT_ID };
  deleteReturning = [{ id: LINK_ID }];
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("linkContentToContractAction", () => {
  it("contractId が UUID でないと invalid、認可も DB も走らせない", async () => {
    const res = await linkContentToContractAction({ contractId: "x", contentId: CONTENT_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("contentId が UUID でないと invalid", async () => {
    const res = await linkContentToContractAction({ contractId: CONTRACT_ID, contentId: "y" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await linkContentToContractAction({ contractId: CONTRACT_ID, contentId: CONTENT_ID });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("成功: contract_contents に正しい値で INSERT し linkId を返す / actor NULL", async () => {
    const res = await linkContentToContractAction({
      contractId: CONTRACT_ID,
      contentId: CONTENT_ID,
      advertiserId: ADV_ID,
    });
    expect(res).toEqual({ ok: true, data: { id: LINK_ID } });
    expect(insertValues).toMatchObject({
      contractId: CONTRACT_ID,
      contentId: CONTENT_ID,
      // system_admin は users 行でないため actor は NULL (ルール1)。
      createdBy: null,
      updatedBy: null,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith(
      `/admin/system/advertisers/${ADV_ID}/contracts`,
    );
  });

  it("監査: table=contract_contents / op=insert / school_id・actor NULL / diff.after に pair", async () => {
    await linkContentToContractAction({ contractId: CONTRACT_ID, contentId: CONTENT_ID });
    expect(auditValues).toMatchObject({
      actorUserId: null,
      schoolId: null,
      tableName: "contract_contents",
      recordId: LINK_ID,
      operation: "insert",
      createdBy: null,
      updatedBy: null,
    });
    expect(auditValues?.diff).toEqual({
      after: { contractId: CONTRACT_ID, contentId: CONTENT_ID },
    });
  });

  it("二重紐付け (UNIQUE 23505) は conflict を返す", async () => {
    uniqueViolation = true;
    const res = await linkContentToContractAction({
      contractId: CONTRACT_ID,
      contentId: CONTENT_ID,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("存在しない契約/コンテンツ (FK 23503) は not_found を返す", async () => {
    fkViolation = true;
    const res = await linkContentToContractAction({
      contractId: CONTRACT_ID,
      contentId: CONTENT_ID,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("advertiserId が無くても link は成功する (revalidate はスキップ)", async () => {
    const res = await linkContentToContractAction({
      contractId: CONTRACT_ID,
      contentId: CONTENT_ID,
    });
    expect(res).toEqual({ ok: true, data: { id: LINK_ID } });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("unlinkContentFromContractAction", () => {
  it("linkId が UUID でないと invalid、認可も DB も走らせない", async () => {
    const res = await unlinkContentFromContractAction({ linkId: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("requireRole を SYSTEM_ADMIN_ROLES で呼ぶ", async () => {
    await unlinkContentFromContractAction({ linkId: LINK_ID });
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("成功: DELETE し linkId を返す / revalidate", async () => {
    const res = await unlinkContentFromContractAction({ linkId: LINK_ID, advertiserId: ADV_ID });
    expect(res).toEqual({ ok: true, data: { id: LINK_ID } });
    expect(revalidatePathMock).toHaveBeenCalledWith(
      `/admin/system/advertisers/${ADV_ID}/contracts`,
    );
  });

  it("監査: op=delete / diff.before に解除前の pair / NULL school・actor", async () => {
    beforeRow = { contractId: CONTRACT_ID, contentId: CONTENT_ID };
    await unlinkContentFromContractAction({ linkId: LINK_ID });
    expect(auditValues).toMatchObject({
      tableName: "contract_contents",
      operation: "delete",
      schoolId: null,
      actorUserId: null,
    });
    expect(auditValues?.diff).toEqual({
      before: { contractId: CONTRACT_ID, contentId: CONTENT_ID },
    });
  });

  it("対象の紐付けが無い (select 0 行) は not_found、DELETE しない", async () => {
    beforeRow = undefined;
    const res = await unlinkContentFromContractAction({ linkId: LINK_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(auditValues).toBeNull();
  });

  it("SELECT は通るが DELETE 0 行 (多層防御) も not_found", async () => {
    beforeRow = { contractId: CONTRACT_ID, contentId: CONTENT_ID };
    deleteReturning = [];
    const res = await unlinkContentFromContractAction({ linkId: LINK_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
