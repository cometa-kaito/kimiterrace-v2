import { describe, expect, it } from "vitest";
import {
  type EditorTarget,
  editorBasePath,
  parseEditorTarget,
  targetId,
  targetIdColumns,
} from "../../lib/editor/schedule-core";

/**
 * `EditorTarget` の解析 / 列導出 / route 生成 (段A-2) の純粋ロジック検証。scope と id の整合 (どの
 * `*_id` 列を埋めるか / どの path に行くか) を 1 か所に閉じ込めた helper の単体。
 */

const DEPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GRADE_ID = "99999999-9999-4999-8999-999999999999";
const CLASS_ID = "11111111-1111-4111-8111-111111111111";

describe("parseEditorTarget", () => {
  it("school は id 不要で受理する", () => {
    expect(parseEditorTarget("school", null)).toEqual({ scope: "school" });
    expect(parseEditorTarget("school", "ignored")).toEqual({ scope: "school" });
  });

  it("department/grade/class は UUID id を要求する", () => {
    expect(parseEditorTarget("department", DEPT_ID)).toEqual({
      scope: "department",
      departmentId: DEPT_ID,
    });
    expect(parseEditorTarget("grade", GRADE_ID)).toEqual({ scope: "grade", gradeId: GRADE_ID });
    expect(parseEditorTarget("class", CLASS_ID)).toEqual({ scope: "class", classId: CLASS_ID });
  });

  it("非 UUID id (school 以外) は null", () => {
    expect(parseEditorTarget("class", "not-a-uuid")).toBeNull();
    expect(parseEditorTarget("grade", null)).toBeNull();
    expect(parseEditorTarget("department", 123)).toBeNull();
  });

  it("未知の scope は null", () => {
    expect(parseEditorTarget("teacher", CLASS_ID)).toBeNull();
    expect(parseEditorTarget(undefined, CLASS_ID)).toBeNull();
  });
});

describe("targetIdColumns", () => {
  const cases: Array<[EditorTarget, ReturnType<typeof targetIdColumns>]> = [
    [{ scope: "school" }, { scope: "school", gradeId: null, departmentId: null, classId: null }],
    [
      { scope: "department", departmentId: DEPT_ID },
      { scope: "department", gradeId: null, departmentId: DEPT_ID, classId: null },
    ],
    [
      { scope: "grade", gradeId: GRADE_ID },
      { scope: "grade", gradeId: GRADE_ID, departmentId: null, classId: null },
    ],
    [
      { scope: "class", classId: CLASS_ID },
      { scope: "class", gradeId: null, departmentId: null, classId: CLASS_ID },
    ],
  ];
  for (const [target, expected] of cases) {
    it(`${target.scope} は ck_daily_data_scope を充足する列の組を返す`, () => {
      expect(targetIdColumns(target)).toEqual(expected);
    });
  }
});

describe("targetId", () => {
  it("school は null、他は対応 id", () => {
    expect(targetId({ scope: "school" })).toBeNull();
    expect(targetId({ scope: "department", departmentId: DEPT_ID })).toBe(DEPT_ID);
    expect(targetId({ scope: "grade", gradeId: GRADE_ID })).toBe(GRADE_ID);
    expect(targetId({ scope: "class", classId: CLASS_ID })).toBe(CLASS_ID);
  });
});

describe("editorBasePath", () => {
  it("class は既存 /admin/editor/[classId]、scope は /admin/editor/scope/...", () => {
    expect(editorBasePath({ scope: "class", classId: CLASS_ID })).toBe(`/admin/editor/${CLASS_ID}`);
    expect(editorBasePath({ scope: "school" })).toBe("/admin/editor/scope/school");
    expect(editorBasePath({ scope: "department", departmentId: DEPT_ID })).toBe(
      `/admin/editor/scope/department/${DEPT_ID}`,
    );
    expect(editorBasePath({ scope: "grade", gradeId: GRADE_ID })).toBe(
      `/admin/editor/scope/grade/${GRADE_ID}`,
    );
  });
});
