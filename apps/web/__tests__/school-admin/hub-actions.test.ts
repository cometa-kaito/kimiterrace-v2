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
const getClassYearRowsMock = vi.fn();
const getTargetYearClassKeysMock = vi.fn();
vi.mock("../../lib/school-admin/hub-queries", () => ({
  countGradesInDepartment: (...a: unknown[]) => countGradesInDepartmentMock(...a),
  countClassesInGrade: (...a: unknown[]) => countClassesInGradeMock(...a),
  getClassYearRows: (...a: unknown[]) => getClassYearRowsMock(...a),
  getTargetYearClassKeys: (...a: unknown[]) => getTargetYearClassKeysMock(...a),
}));

import { requireRole } from "../../lib/auth/guard";
import { withSession } from "../../lib/db";
import {
  deleteClassAction,
  deleteDepartmentAction,
  deleteGradeAction,
  duplicateClassesToNextYearAction,
  updateClassAction,
  updateDepartmentAction,
  updateGradeAction,
} from "../../lib/school-admin/hub-actions";
import { classDupKey } from "../../lib/school-admin/hub-core";

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
const insertSpy = vi.fn();
const NEW_ID = "66666666-6666-4666-8666-666666666666";
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
    returning: () => Promise.resolve([{ id: NEW_ID }]),
  };
  return {
    select: () => makeSelectChain(selectQueue.shift() ?? []),
    update: () => writeChain,
    delete: () => writeChain,
    insert: (...a: unknown[]) => {
      insertSpy(...a);
      return writeChain;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleMock.mockResolvedValue(admin);
  countGradesInDepartmentMock.mockResolvedValue(0);
  countClassesInGradeMock.mockResolvedValue(0);
  getTargetYearClassKeysMock.mockResolvedValue(new Set<string>());
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

describe("duplicateClassesToNextYearAction", () => {
  it("schoolId 無し (テナント未選択) は forbidden、DB に到達しない", async () => {
    requireRoleMock.mockResolvedValue({ uid: USER_ID, role: "system_admin", schoolId: null });
    const res = await duplicateClassesToNextYearAction();
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("複製できるクラスが無ければ not_found", async () => {
    getClassYearRowsMock.mockResolvedValue([]);
    const res = await duplicateClassesToNextYearAction();
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("最新年度のクラスを翌年度へ複製し、件数と対象年度を返す (gradeId=null は除外)", async () => {
    getClassYearRowsMock.mockResolvedValue([
      { gradeId: GRADE_ID, name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: GRADE_ID, name: "2組", grade: 1, academicYear: 2026 },
      { gradeId: null, name: "未割当", grade: 1, academicYear: 2026 },
    ]);
    const res = await duplicateClassesToNextYearAction();
    expect(res).toEqual({ ok: true, data: { created: 2, targetYear: 2027 } });
  });

  it("複製クラスごとに classes と audit_log へ insert する (ルール1 監査)", async () => {
    getClassYearRowsMock.mockResolvedValue([
      { gradeId: GRADE_ID, name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: GRADE_ID, name: "2組", grade: 1, academicYear: 2026 },
    ]);
    await duplicateClassesToNextYearAction();
    // 2 クラス × (classes 行 + audit_log 行) = 4 回の insert。
    expect(insertSpy).toHaveBeenCalledTimes(4);
  });

  it("target 年度に既存のクラスは除外して複製する（冪等化）", async () => {
    getClassYearRowsMock.mockResolvedValue([
      { gradeId: GRADE_ID, name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: GRADE_ID, name: "2組", grade: 1, academicYear: 2026 },
    ]);
    // 1組 は既に翌年度(target)に存在 → 除外。2組 のみ複製される。
    getTargetYearClassKeysMock.mockResolvedValue(new Set([classDupKey(GRADE_ID, "1組")]));
    const res = await duplicateClassesToNextYearAction();
    expect(res).toEqual({ ok: true, data: { created: 1, targetYear: 2027 } });
    // 1 クラス × (classes 行 + audit_log 行) = 2 回の insert。
    expect(insertSpy).toHaveBeenCalledTimes(2);
    // 既存クラスの取得は target 年度 (2027) で呼ばれる。
    expect(getTargetYearClassKeysMock).toHaveBeenCalledWith(expect.anything(), 2027);
  });

  it("target に全クラスが既存なら created:0（重複生成せず graceful）", async () => {
    getClassYearRowsMock.mockResolvedValue([
      { gradeId: GRADE_ID, name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: GRADE_ID, name: "2組", grade: 1, academicYear: 2026 },
    ]);
    getTargetYearClassKeysMock.mockResolvedValue(
      new Set([classDupKey(GRADE_ID, "1組"), classDupKey(GRADE_ID, "2組")]),
    );
    const res = await duplicateClassesToNextYearAction();
    expect(res).toEqual({ ok: true, data: { created: 0, targetYear: 2027 } });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("並行/重複時の unique 違反 (23505) は conflict に写像（DB index が砦）", async () => {
    getClassYearRowsMock.mockResolvedValue([
      { gradeId: GRADE_ID, name: "1組", grade: 1, academicYear: 2026 },
    ]);
    // 並行 tx が観測されず insert が ux_classes_school_year_grade_name に衝突したケース。
    withSessionMock.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await duplicateClassesToNextYearAction();
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
