import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #48-L3 (#123): createSchoolAction の配線テスト。
 *
 * next/cache・guard・db を mock (`@kimiterrace/db` は mock しない — schools/auditLog/createSchool の
 * 実体が要る)。fakeTx の insert は createSchool (`.values().returning()`) と audit (`.values()` を await)
 * の双方に対応する thenable を返す。
 *
 * 重点:
 *  - 入力検証で DB/認可に到達しないこと。
 *  - 認可は system_admin 限定 (requireRole が ["system_admin"] で呼ばれる、非 system_admin は redirect)。
 *  - 正常系で新規校 id を返す。unique(23505) → conflict。
 *  - 監査: operation="insert"、system_admin は actor/created_by/updated_by を NULL、school_id=新規校 id。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import { createSchoolAction } from "../../lib/system-admin/schools-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const NEW_ID = "22222222-2222-4222-8222-222222222222";
const SYS_UID = "99999999-9999-4999-8999-999999999999";
const sysAdmin = { uid: SYS_UID, role: "system_admin" as const, schoolId: null };

const validRaw = {
  name: "岐南工業高校",
  prefecture: "岐阜県",
  code: "G001",
  hierarchyMode: "department",
};

/** values() に渡された全ペイロード (1=createSchool, 2=audit)。 */
let captured: Record<string, unknown>[];
let insertReturning: unknown[];

function fakeTx() {
  const insertChain = {
    values: (v: Record<string, unknown>) => {
      captured.push(v);
      // createSchool は `.values().returning()` を await、audit は `.values()` を直接 await する。
      // 両対応のため「Promise (await で undefined に解決) に returning() を生やしたもの」を返す
      // (オブジェクトリテラルに then を足すと lint/suspicious/noThenProperty に触れるため避ける)。
      const result = Promise.resolve(undefined) as Promise<undefined> & {
        returning: () => Promise<unknown[]>;
      };
      result.returning = () => Promise.resolve(insertReturning);
      return result;
    },
  };
  return { insert: () => insertChain };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(sysAdmin);
  captured = [];
  insertReturning = [{ id: NEW_ID }];
  withSessionMock.mockImplementation(((fn: (tx: unknown, user: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx(), sysAdmin))) as typeof withSession);
});

describe("createSchoolAction (入力検証)", () => {
  it("空の学校名は invalid を返し、認可も DB も走らせない", async () => {
    const res = await createSchoolAction({ ...validRaw, name: "  " });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("未知の階層モードは invalid", async () => {
    const res = await createSchoolAction({ ...validRaw, hierarchyMode: "grade" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });
});

describe("createSchoolAction (認可: system_admin 限定)", () => {
  it("requireRole を SYSTEM_ADMIN_ROLES (system_admin のみ) で呼ぶ", async () => {
    await createSchoolAction(validRaw);
    expect(requireRoleMock).toHaveBeenCalledWith(["system_admin"]);
  });

  it("非 system_admin は requireRole が redirect (throw) し DB に到達しない", async () => {
    requireRoleMock.mockRejectedValue(new Error("NEXT_REDIRECT:/forbidden"));
    await expect(createSchoolAction(validRaw)).rejects.toThrow("NEXT_REDIRECT");
    expect(withSessionMock).not.toHaveBeenCalled();
  });
});

describe("createSchoolAction (DB 経路)", () => {
  it("正常系: 作成して新規校 id を返す", async () => {
    const res = await createSchoolAction(validRaw);
    expect(res).toEqual({ ok: true, data: { id: NEW_ID } });
  });

  it("unique 違反 (23505) は conflict に写像", async () => {
    withSessionMock.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await createSchoolAction(validRaw);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("INSERT が 0 行 (WITH CHECK 不成立) は not_found", async () => {
    insertReturning = [];
    const res = await createSchoolAction(validRaw);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("createSchool に created_by=NULL (system_admin は users 行でない) を渡す", async () => {
    await createSchoolAction(validRaw);
    // 1 件目 = createSchool の values。
    expect(captured[0]).toMatchObject({
      name: "岐南工業高校",
      prefecture: "岐阜県",
      code: "G001",
      hierarchyMode: "department",
      createdBy: null,
      updatedBy: null,
    });
  });

  it("監査: operation=insert / actor 系 NULL だが actor_identity_uid に IdP uid / school_id=新規校 id", async () => {
    await createSchoolAction(validRaw);
    const audit = captured.find((v) => v.tableName === "schools");
    expect(audit).toMatchObject({
      // system_admin は actor 系を FK 制約で NULL、実行者は actor_identity_uid に保持 (#858/#859 同型)。
      actorUserId: null,
      actorIdentityUid: SYS_UID,
      createdBy: null,
      updatedBy: null,
      schoolId: NEW_ID,
      tableName: "schools",
      recordId: NEW_ID,
      operation: "insert",
    });
  });
});
