import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #48-L (#123): updateSchoolAction の配線テスト (hub-actions.test.ts と同方針)。
 *
 * next/cache・guard・db を mock。`@kimiterrace/db` は **mock しない** (schools テーブル定義・
 * getSchool/updateSchool/eq の実体が要るため)。`withSession` は callback を fake tx で実行し、
 * not_found / conflict / 正常系を通す。
 *
 * 重点:
 *  - 入力検証で DB に到達しないこと (requireRole も走らせない)。
 *  - **認可は system_admin 限定**: requireRole が SYSTEM_ADMIN_ROLES (["system_admin"]) で呼ばれること。
 *    非 system_admin は requireRole が /forbidden に redirect する (本物の挙動) のを、mock の throw で
 *    再現し、DB に到達しないことを固定する。
 *  - getSchool 0 件 → not_found、unique(23505) → conflict、正常系 → id を返す。
 *  - **監査 actor**: system_admin は users 行でないため created_by/actor_user_id を NULL で書くこと。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { updateSchoolAction } from "../../lib/system-admin/schools-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const SYS_UID = "99999999-9999-4999-8999-999999999999";

const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

const validRaw = {
  id: SCHOOL_ID,
  name: "岐南工業高校",
  prefecture: "岐阜県",
  code: "G001",
  hierarchyMode: "department",
};

/** insert に渡された audit values をキャプチャするための置き場。 */
let capturedAuditValues: Record<string, unknown> | null;
/** getSchool の select が返す行 / updateSchool の returning が返す行。 */
let selectRows: unknown[];
let returningRows: unknown[];

function fakeTx() {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(selectRows),
  };
  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => Promise.resolve(returningRows),
  };
  const insertChain = {
    values: (v: Record<string, unknown>) => {
      capturedAuditValues = v;
      return Promise.resolve(undefined);
    },
  };
  return {
    select: () => selectChain,
    update: () => updateChain,
    insert: () => insertChain,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  capturedAuditValues = null;
  selectRows = [
    { id: SCHOOL_ID, name: "旧名", prefecture: "岐阜県", code: "OLD", hierarchyMode: "class" },
  ];
  returningRows = [{ id: SCHOOL_ID }];
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("updateSchoolAction (入力検証)", () => {
  it("不正な id は invalid を返し、認可も DB も走らせない", async () => {
    const res = await updateSchoolAction({ ...validRaw, id: "nope" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("空の学校名は DB に到達せず invalid", async () => {
    const res = await updateSchoolAction({ ...validRaw, name: "  " });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("未知の階層モードは invalid", async () => {
    const res = await updateSchoolAction({ ...validRaw, hierarchyMode: "grade" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });
});

describe("updateSchoolAction (認可: system_admin 限定)", () => {
  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await updateSchoolAction(validRaw);
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("非 system_admin は requireRole が redirect (throw) し、DB に到達しない", async () => {
    // 本物の requireRole は role 不足で next/navigation の redirect() を投げる。mock で再現する。
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(updateSchoolAction(validRaw)).rejects.toThrow("NEXT_REDIRECT");
    expect(withSessionMock).not.toHaveBeenCalled();
  });
});

describe("updateSchoolAction (DB 経路)", () => {
  it("対象校が RLS で不可視 (getSchool 0 件) は not_found、更新しない", async () => {
    selectRows = [];
    const res = await updateSchoolAction(validRaw);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("UPDATE が 0 行 (競合で不可視化) は not_found", async () => {
    returningRows = [];
    const res = await updateSchoolAction(validRaw);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("unique 違反 (23505) は conflict に写像 (学校コード重複)", async () => {
    withSessionMock.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await updateSchoolAction(validRaw);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("正常系: 更新して id を返す", async () => {
    const res = await updateSchoolAction(validRaw);
    expect(res).toEqual({ ok: true, data: { id: SCHOOL_ID } });
  });

  it("監査: system_admin は actor_user_id / created_by / updated_by を NULL、school_id に対象校 id", async () => {
    await updateSchoolAction(validRaw);
    expect(capturedAuditValues).toMatchObject({
      actorUserId: null,
      createdBy: null,
      updatedBy: null,
      schoolId: SCHOOL_ID,
      tableName: "schools",
      recordId: SCHOOL_ID,
      operation: "update",
    });
  });

  it("監査 diff に before/after を残す (hierarchyMode 切替を含む)", async () => {
    await updateSchoolAction(validRaw);
    expect(capturedAuditValues?.diff).toMatchObject({
      before: { hierarchyMode: "class" },
      after: { hierarchyMode: "department", name: "岐南工業高校" },
    });
  });
});
