import { describe, expect, it } from "vitest";
import type { PublishScopeValue } from "../../lib/contents/publish-core";
import {
  type ContentAudience,
  type StudentContext,
  canStudentSeeContent,
  filterVisibleContents,
  normalizeTargets,
} from "../../lib/contents/visibility";

/**
 * F04 + F05/F06: 生徒向け可視性判定の網羅検証。scope×class の audience 境界を固定する。
 */

const SCHOOL_A = "school-a";
const SCHOOL_B = "school-b";
const CLASS_1 = "class-1";
const CLASS_2 = "class-2";

const studentA1: StudentContext = { schoolId: SCHOOL_A, classId: CLASS_1 };

function content(scope: PublishScopeValue, over: Partial<ContentAudience> = {}): ContentAudience {
  return { schoolId: SCHOOL_A, scope, targets: [], ...over };
}

describe("canStudentSeeContent — テナント境界", () => {
  it("別校のコンテンツは school_mismatch", () => {
    expect(canStudentSeeContent(content("school", { schoolId: SCHOOL_B }), studentA1)).toEqual({
      visible: false,
      reason: "school_mismatch",
    });
  });

  it("コンテンツ校が未設定(null/空)なら school_mismatch", () => {
    expect(canStudentSeeContent(content("school", { schoolId: null }), studentA1).visible).toBe(
      false,
    );
    expect(canStudentSeeContent(content("school", { schoolId: "" }), studentA1)).toEqual({
      visible: false,
      reason: "school_mismatch",
    });
  });

  it("生徒校が未設定(空)なら school_mismatch", () => {
    expect(canStudentSeeContent(content("school"), { schoolId: "", classId: CLASS_1 })).toEqual({
      visible: false,
      reason: "school_mismatch",
    });
  });
});

describe("canStudentSeeContent — scope 突合", () => {
  it("school scope は同一校の全生徒に可視", () => {
    expect(canStudentSeeContent(content("school"), studentA1)).toEqual({ visible: true });
    expect(
      canStudentSeeContent(content("school"), { schoolId: SCHOOL_A, classId: null }).visible,
    ).toBe(true);
  });

  it("private scope は生徒に非可視 (not_published)", () => {
    expect(canStudentSeeContent(content("private"), studentA1)).toEqual({
      visible: false,
      reason: "not_published",
    });
  });

  it("class scope は targets に自クラスが含まれれば可視", () => {
    expect(
      canStudentSeeContent(content("class", { targets: [CLASS_1, CLASS_2] }), studentA1),
    ).toEqual({ visible: true });
  });

  it("class scope で自クラスが対象外なら out_of_scope", () => {
    expect(canStudentSeeContent(content("class", { targets: [CLASS_2] }), studentA1)).toEqual({
      visible: false,
      reason: "out_of_scope",
    });
  });

  it("homeroom scope も targets で突合する", () => {
    expect(canStudentSeeContent(content("homeroom", { targets: [CLASS_1] }), studentA1)).toEqual({
      visible: true,
    });
    expect(canStudentSeeContent(content("homeroom", { targets: [CLASS_2] }), studentA1)).toEqual({
      visible: false,
      reason: "out_of_scope",
    });
  });

  it("class/homeroom scope で生徒クラス未確定なら no_class_context", () => {
    const noClass: StudentContext = { schoolId: SCHOOL_A, classId: null };
    expect(canStudentSeeContent(content("class", { targets: [CLASS_1] }), noClass)).toEqual({
      visible: false,
      reason: "no_class_context",
    });
    expect(
      canStudentSeeContent(content("class", { targets: [CLASS_1] }), {
        schoolId: SCHOOL_A,
        classId: "",
      }),
    ).toEqual({ visible: false, reason: "no_class_context" });
  });
});

describe("filterVisibleContents", () => {
  it("可視のものだけを元順で残す", () => {
    const items = [
      content("school"), // visible
      content("private"), // hidden
      content("class", { targets: [CLASS_1] }), // visible
      content("class", { targets: [CLASS_2] }), // hidden
      content("school", { schoolId: SCHOOL_B }), // hidden (別校)
    ];
    const visible = filterVisibleContents(items, studentA1);
    expect(visible.map((v) => v.scope)).toEqual(["school", "class"]);
  });
});

describe("normalizeTargets", () => {
  it("配列でなければ空配列", () => {
    expect(normalizeTargets(null)).toEqual([]);
    expect(normalizeTargets("class-1")).toEqual([]);
    expect(normalizeTargets({})).toEqual([]);
  });

  it("string 要素のみを残す", () => {
    expect(normalizeTargets([CLASS_1, 42, null, CLASS_2, { id: "x" }])).toEqual([CLASS_1, CLASS_2]);
  });
});
