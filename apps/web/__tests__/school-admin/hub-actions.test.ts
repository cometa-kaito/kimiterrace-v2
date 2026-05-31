import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 学校管理者ハブ update/delete Server Action の配線テスト (#48-K2、PR #164 Reviewer M-1)。
 *
 * next/cache・guard・db・hub-queries を mock。`@kimiterrace/db` は **mock しない**
 * (テーブル定義・eq の実体が要るため)。`withSession` は callback を fake tx で実行し、
 * cross-tenant / not_found / 子参照ガード経路を通す。fake tx の select は呼ばれた順に
 * `selectQueue` から行を返し、「対象再取得 before」と `existsInSchool` を切り替える。
 *
 * 重点: 認可 (SCHOOL_HIERARCHY_ROLES / forbidden)、入力検証で DB に到達しないこと、
 * CrossTenantError→invalid (grade.department_id 他校付替拒否)、HubNotFoundError→not_found、
 * 子参照ガード (ChildExistsError→conflict)、unique→conflict、update/delete 正常系。
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../lib/auth/guard", () => ({ requireRole: vi.fn() }));
vi.mock("../../lib/db", () => ({ withSession: vi.fn() }));

const countGradesInDepartmentMock = vi.fn();
const countClassesInGradeMock = vi.fn();
vi.mock("../../lib/school-admin/hub-queries", () => ({
  countGradesInDepartment: (...a: unknown[]) => countGradesInDepartmentMock(...a),
  countClassesInGrade: (...a: unknown[]) => countClassesInGradeMock(...a),
}));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  deleteClassAction,
  deleteDepartmentAction,
  deleteGradeAction,
  updateClassAction,
  updateDepartmentAction,
  updateGradeAction,
} from "../../lib/school-admin/hub-actions";

const requireRoleMock = vi.mocked(requireRole);
const withSessionMock = vi.mocked(withSession);

const DEPT_ID = "11111111-1111-4111-8111-111111111111";
const GRADE_ID = "22222222-2222-4222-8222-222222222222";
const CLASS_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_DEPT_ID = "99999999-9999-4999-8999-999999999999";
const SCHOOL_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";

const admin = { uid: USER_ID, role: "school_admin" as const, schoolId: SCHOOL_ID };

/**
 * select は呼ばれるたびに `selectQueue` の先頭の行配列を返す fake tx。
 * hub-actions の select は `existsInSchool` / before 再取得とも `.where(...).limit(1)` で終わる
 * (子参照カウントは hub-queries mock 側で処理されるため fake tx に来ない)。update/delete は
 * チェーンを満たすだけ。
 */
let selectQueue: unknown[][];
function fakeTx() {
  const makeSelectChain = (rows: unknown[]) => {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return chain;
  };
  const writeChain = {
    set: () => writeChain,
    values: () => writeChain,
    where: () => Promise.resolve(undefined),
  };
  return {
    select: () => makeSelectChain(selectQueue.shift() ?? []),
    update: () => writeChain,
    delete: () => writeChain,
    insert: () => writeChain,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(admin);
  countGradesInDepartmentMock.mockResolvedValue(0);
  countClassesInGradeMock.mockResolvedValue(0);
  selectQueue = [];
  // callback を fake tx で実行 (実シグネチャは (fn, user) だが tx のみ使う)。
  withSessionMock.mockImplementation(((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx()))) as typeof withSession);
});

describe("updateDepartmentAction", () => {
  it("不正な id は invalid を返し、認可も走らせない", async () => {
    const res = await updateDepartmentAction({ id: "nope", name: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("空名称は DB に到達せず invalid", async () => {
    const res = await updateDepartmentAction({ id: DEPT_ID, name: "  " });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("SCHOOL_HIERARCHY_ROLES のみ認可する", async () => {
    selectQueue = [[{ name: "旧", displayOrder: 0 }]];
    await updateDepartmentAction({ id: DEPT_ID, name: "機械科" });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("schoolId 無し (テナント未選択) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await updateDepartmentAction({ id: DEPT_ID, name: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象が自校で不可視 (再取得 0 件) は not_found", async () => {
    selectQueue = [[]];
    const res = await updateDepartmentAction({ id: DEPT_ID, name: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("unique 違反 (23505) は conflict に写像", async () => {
    selectQueue = [[{ name: "旧", displayOrder: 0 }]];
    withSessionMock.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await updateDepartmentAction({ id: DEPT_ID, name: "重複" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("正常系: 更新して id を返す", async () => {
    selectQueue = [[{ name: "旧", displayOrder: 0 }]];
    const res = await updateDepartmentAction({ id: DEPT_ID, name: "機械科", displayOrder: 2 });
    expect(res).toEqual({ ok: true, data: { id: DEPT_ID } });
  });
});

describe("updateGradeAction", () => {
  it("正常系: リネームして id を返す (departmentId なし)", async () => {
    selectQueue = [[{ name: "旧", displayOrder: 0, hasClasses: true, departmentId: null }]];
    const res = await updateGradeAction({ id: GRADE_ID, name: "2年" });
    expect(res).toEqual({ ok: true, data: { id: GRADE_ID } });
  });

  it("対象不存在は not_found", async () => {
    selectQueue = [[]];
    const res = await updateGradeAction({ id: GRADE_ID, name: "2年" });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("cross-tenant: 他校 department への付替は invalid (再取得は成功、existsInSchool 0 件)", async () => {
    // 1 回目 select = before (存在)、2 回目 select = existsInSchool (不可視 → 0 件)。
    selectQueue = [[{ name: "1年", displayOrder: 0, hasClasses: true, departmentId: null }], []];
    const res = await updateGradeAction({ id: GRADE_ID, name: "1年", departmentId: OTHER_DEPT_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("自校 department への付替は正常 (existsInSchool 1 件)", async () => {
    selectQueue = [
      [{ name: "1年", displayOrder: 0, hasClasses: true, departmentId: null }],
      [{ id: DEPT_ID }],
    ];
    const res = await updateGradeAction({ id: GRADE_ID, name: "1年", departmentId: DEPT_ID });
    expect(res).toEqual({ ok: true, data: { id: GRADE_ID } });
  });
});

describe("updateClassAction", () => {
  it("年度域外は DB に到達せず invalid", async () => {
    const res = await updateClassAction({
      id: CLASS_ID,
      name: "A組",
      academicYear: 1999,
      grade: 1,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象不存在は not_found", async () => {
    selectQueue = [[]];
    const res = await updateClassAction({
      id: CLASS_ID,
      name: "A組",
      academicYear: 2026,
      grade: 1,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: 更新して id を返す", async () => {
    selectQueue = [[{ name: "A組", academicYear: 2025, grade: 1 }]];
    const res = await updateClassAction({
      id: CLASS_ID,
      name: "B組",
      academicYear: 2026,
      grade: 2,
    });
    expect(res).toEqual({ ok: true, data: { id: CLASS_ID } });
  });
});

describe("deleteDepartmentAction", () => {
  it("不正な id は invalid、認可も走らせない", async () => {
    const res = await deleteDepartmentAction("nope");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("対象不存在は not_found", async () => {
    selectQueue = [[]]; // existsInSchool 0 件
    const res = await deleteDepartmentAction(DEPT_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("子参照ガード: 属する学年があれば conflict (削除しない)", async () => {
    selectQueue = [[{ id: DEPT_ID }]]; // existsInSchool 1 件
    countGradesInDepartmentMock.mockResolvedValue(2);
    const res = await deleteDepartmentAction(DEPT_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("正常系: 子無しなら削除して id を返す", async () => {
    selectQueue = [[{ id: DEPT_ID }]];
    countGradesInDepartmentMock.mockResolvedValue(0);
    const res = await deleteDepartmentAction(DEPT_ID);
    expect(res).toEqual({ ok: true, data: { id: DEPT_ID } });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });
});

describe("deleteGradeAction", () => {
  it("子参照ガード: 属するクラスがあれば conflict", async () => {
    selectQueue = [[{ id: GRADE_ID }]];
    countClassesInGradeMock.mockResolvedValue(1);
    const res = await deleteGradeAction(GRADE_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("正常系: 子無しなら削除", async () => {
    selectQueue = [[{ id: GRADE_ID }]];
    countClassesInGradeMock.mockResolvedValue(0);
    const res = await deleteGradeAction(GRADE_ID);
    expect(res).toEqual({ ok: true, data: { id: GRADE_ID } });
  });

  it("対象不存在は not_found", async () => {
    selectQueue = [[]];
    const res = await deleteGradeAction(GRADE_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("deleteClassAction", () => {
  it("不正な id は invalid", async () => {
    const res = await deleteClassAction("x");
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("対象不存在は not_found", async () => {
    selectQueue = [[]];
    const res = await deleteClassAction(CLASS_ID);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: 末端なので子参照ガード無しで削除", async () => {
    selectQueue = [[{ id: CLASS_ID }]];
    const res = await deleteClassAction(CLASS_ID);
    expect(res).toEqual({ ok: true, data: { id: CLASS_ID } });
    expect(countClassesInGradeMock).not.toHaveBeenCalled();
  });
});
