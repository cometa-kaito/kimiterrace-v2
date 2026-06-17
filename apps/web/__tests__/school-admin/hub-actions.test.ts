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
  createDepartmentAction,
  createOtherLocationAction,
  deleteClassAction,
  deleteDepartmentAction,
  deleteGradeAction,
  reorderHierarchyAction,
  updateClassAction,
  updateDepartmentAction,
  updateGradeAction,
  updateOtherLocationAction,
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
 * 本番の drizzle が投げる形の pg エラーを再現する。元の pg エラー (SQLSTATE 付き) を
 * DrizzleQueryError ("Failed query: …") が `cause` でラップするため、`code` は top-level ではなく
 * `cause` 側に載る。helper はこの cause チェーンを辿れて初めて重複を conflict に写せる。
 */
function drizzleWrapped(code: string): Error {
  return Object.assign(new Error("Failed query: insert into ..."), {
    cause: Object.assign(new Error("duplicate key value violates unique constraint"), { code }),
  });
}

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
  selectQueue = [];
  // callback を fake tx で実行 (実シグネチャは (fn, user) だが tx のみ使う)。
  withSessionMock.mockImplementation(((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(fakeTx()))) as typeof withSession);
});

describe("createDepartmentAction", () => {
  it("同名の学科を二重登録すると conflict (本番 digest 2578603502 の回帰ガード)", async () => {
    // 本番で発生したクラッシュ: 既存の学科名「電子工学科」を再登録 → DB の ux_departments_school_name
    // 違反 (23505) を drizzle が cause にラップ → 旧 helper が取りこぼし未捕捉例外 → エラー境界 500。
    withSessionMock.mockRejectedValue(drizzleWrapped("23505"));
    const res = await createDepartmentAction({ name: "電子工学科" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
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

  it("unique 違反 (23505) は conflict に写像 (drizzle が cause にラップした SQLSTATE も拾う)", async () => {
    selectQueue = [[{ name: "旧", displayOrder: 0 }]];
    // 本番の drizzle は元の pg エラーを DrizzleQueryError ("Failed query: …") でラップし、SQLSTATE は
    // top-level ではなく `.cause.code` に入る。以前の helper は top-level の code しか見ず、重複が
    // conflict ではなく未捕捉例外 → エラー境界 500 (digest 2578603502) になっていた回帰のガード。
    withSessionMock.mockRejectedValue(drizzleWrapped("23505"));
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
  it("学年数域外は DB に到達せず invalid", async () => {
    const res = await updateClassAction({
      id: CLASS_ID,
      name: "A組",
      grade: 0,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("対象不存在は not_found", async () => {
    selectQueue = [[]];
    const res = await updateClassAction({
      id: CLASS_ID,
      name: "A組",
      grade: 1,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: 更新して id を返す", async () => {
    selectQueue = [[{ name: "A組", grade: 1 }]];
    const res = await updateClassAction({
      id: CLASS_ID,
      name: "B組",
      grade: 2,
    });
    expect(res).toEqual({ ok: true, data: { id: CLASS_ID } });
  });
});

describe("createOtherLocationAction（その他＝学年なしクラス）", () => {
  it("空名称は DB に到達せず invalid", async () => {
    const res = await createOtherLocationAction({ name: "  " });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("SCHOOL_HIERARCHY_ROLES のみ認可する", async () => {
    selectQueue = [[]]; // otherLocationNameExists: 重複なし
    await createOtherLocationAction({ name: "玄関" });
    expect(requireRoleMock).toHaveBeenCalledWith(["school_admin", "system_admin"]);
  });

  it("学校直下: 重複なしなら作成（classes + audit の 2 回 insert）", async () => {
    selectQueue = [[]]; // otherLocationNameExists 0 件
    const res = await createOtherLocationAction({ name: "玄関" });
    expect(res).toEqual({ ok: true, data: { id: NEW_ID } });
    expect(insertSpy).toHaveBeenCalledTimes(2);
  });

  it("学校直下: 同名が既にあれば conflict（DB 部分 unique 外を app で封鎖）", async () => {
    selectQueue = [[{ id: CLASS_ID }]]; // otherLocationNameExists 1 件
    const res = await createOtherLocationAction({ name: "玄関" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("学科配下: 他校 department 指定は invalid（existsInSchool 0 件＝cross-tenant 拒否）", async () => {
    selectQueue = [[]]; // existsInSchool 0 件
    const res = await createOtherLocationAction({ name: "廊下", departmentId: OTHER_DEPT_ID });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("学科配下: 自校 department + 重複なしなら作成", async () => {
    selectQueue = [[{ id: DEPT_ID }], []]; // existsInSchool 1 件 → otherLocationNameExists 0 件
    const res = await createOtherLocationAction({ name: "廊下", departmentId: DEPT_ID });
    expect(res).toEqual({ ok: true, data: { id: NEW_ID } });
  });
});

describe("updateOtherLocationAction", () => {
  it("不正な id は invalid、認可も走らせない", async () => {
    const res = await updateOtherLocationAction({ id: "x", name: "正門" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("対象不存在は not_found", async () => {
    selectQueue = [[]]; // before 再取得 0 件
    const res = await updateOtherLocationAction({ id: CLASS_ID, name: "正門" });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("学年ありの通常クラスを指定したら not_found（その他ではない）", async () => {
    selectQueue = [[{ name: "A組", departmentId: null, gradeId: GRADE_ID }]];
    const res = await updateOtherLocationAction({ id: CLASS_ID, name: "正門" });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: リネームして id を返す（学校直下・重複なし）", async () => {
    selectQueue = [[{ name: "玄関", departmentId: null, gradeId: null }], []];
    const res = await updateOtherLocationAction({ id: CLASS_ID, name: "正門" });
    expect(res).toEqual({ ok: true, data: { id: CLASS_ID } });
  });

  it("重複名は conflict", async () => {
    selectQueue = [[{ name: "玄関", departmentId: null, gradeId: null }], [{ id: OTHER_DEPT_ID }]];
    const res = await updateOtherLocationAction({ id: CLASS_ID, name: "廊下" });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("他校 department への付替は invalid（cross-tenant）", async () => {
    selectQueue = [[{ name: "玄関", departmentId: null, gradeId: null }], []];
    const res = await updateOtherLocationAction({
      id: CLASS_ID,
      name: "玄関",
      departmentId: OTHER_DEPT_ID,
    });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
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

describe("reorderHierarchyAction", () => {
  it("不正な entity は invalid を返し、認可も DB も走らせない", async () => {
    const res = await reorderHierarchyAction({ entity: "class", orderedIds: [DEPT_ID] });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("空 / 非UUID / 重複の orderedIds は DB に到達せず invalid", async () => {
    expect(await reorderHierarchyAction({ entity: "department", orderedIds: [] })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(
      await reorderHierarchyAction({ entity: "department", orderedIds: ["nope"] }),
    ).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(
      await reorderHierarchyAction({ entity: "department", orderedIds: [DEPT_ID, DEPT_ID] }),
    ).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("自校で不可視な id が混ざると not_found（全体巻き戻し）", async () => {
    selectQueue = [[]]; // 先頭 id の可視性チェックで 0 件 → HubNotFoundError。
    const res = await reorderHierarchyAction({
      entity: "department",
      orderedIds: [DEPT_ID, OTHER_DEPT_ID],
    });
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("正常系: 並びが変わった件数を返し、変更行のみ監査する", async () => {
    // orderedIds=[DEPT_ID→0, OTHER_DEPT_ID→1]。現在 5 / 6 ゆえ 2 件変更。
    selectQueue = [[{ displayOrder: 5 }], [{ displayOrder: 6 }]];
    const res = await reorderHierarchyAction({
      entity: "department",
      orderedIds: [DEPT_ID, OTHER_DEPT_ID],
    });
    expect(res).toEqual({ ok: true, data: { count: 2 } });
    expect(insertSpy).toHaveBeenCalledTimes(2); // 監査は変更行ごとに 1 行
  });

  it("既に正しい順の行は更新も監査もしない（無駄 write 抑制）", async () => {
    // DEPT_ID は既に index 0、OTHER_DEPT_ID のみ index 1 へ変更。
    selectQueue = [[{ displayOrder: 0 }], [{ displayOrder: 9 }]];
    const res = await reorderHierarchyAction({
      entity: "department",
      orderedIds: [DEPT_ID, OTHER_DEPT_ID],
    });
    expect(res).toEqual({ ok: true, data: { count: 1 } });
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("学年も並べ替えできる（entity=grade）", async () => {
    selectQueue = [[{ displayOrder: 3 }], [{ displayOrder: 4 }]];
    const res = await reorderHierarchyAction({
      entity: "grade",
      orderedIds: [GRADE_ID, OTHER_DEPT_ID],
    });
    expect(res).toEqual({ ok: true, data: { count: 2 } });
  });
});

/**
 * system_admin が /ops/schools/[id]/hierarchy から特定校を対象に編集する経路の配線。
 * actor が system_admin (session schoolId=null) のとき、各 action に渡した `targetSchoolId` が
 * `withSession(..., { tenantScoped: true, schoolId })` へ伝播することを固定する。実際の越境封じ
 * (override は system_admin のみ honor / 降格 RLS) は packages/db の実 PG テストで担保する。
 */
describe("system_admin: 対象校スコープの配線", () => {
  const SYS_UID = "77777777-7777-4777-8777-777777777777";
  const TARGET = "88888888-8888-4888-8888-888888888888";

  beforeEach(() => {
    requireRoleMock.mockResolvedValue({ uid: SYS_UID, role: "system_admin", schoolId: null });
  });

  it("対象校未指定は forbidden、DB に到達しない", async () => {
    const res = await updateDepartmentAction({ id: DEPT_ID, name: "x" });
    expect(res).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(withSessionMock).not.toHaveBeenCalled();
  });

  it("update: 対象校指定で withSession に { tenantScoped, schoolId } を渡す", async () => {
    selectQueue = [[{ name: "旧", displayOrder: 0 }]];
    const res = await updateDepartmentAction({ id: DEPT_ID, name: "機械科" }, TARGET);
    expect(res).toEqual({ ok: true, data: { id: DEPT_ID } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: TARGET,
    });
  });

  it("delete: 対象校 schoolId を渡す", async () => {
    selectQueue = [[{ id: GRADE_ID }]];
    countClassesInGradeMock.mockResolvedValue(0);
    const res = await deleteGradeAction(GRADE_ID, TARGET);
    expect(res).toEqual({ ok: true, data: { id: GRADE_ID } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: TARGET,
    });
  });

  it("reorder: 対象校 schoolId を渡す", async () => {
    selectQueue = [[{ displayOrder: 5 }]];
    const res = await reorderHierarchyAction(
      { entity: "department", orderedIds: [DEPT_ID] },
      TARGET,
    );
    expect(res).toEqual({ ok: true, data: { count: 1 } });
    expect(withSessionMock).toHaveBeenCalledWith(expect.any(Function), {
      tenantScoped: true,
      schoolId: TARGET,
    });
  });
});
