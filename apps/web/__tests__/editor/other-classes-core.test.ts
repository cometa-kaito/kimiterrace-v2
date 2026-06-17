import { describe, expect, it } from "vitest";
import {
  type OtherClass,
  computeTodayActiveOtherClasses,
} from "../../lib/editor/other-classes-queries";

/**
 * PR4: 「その他」(grade_id NULL の非教室設置場所) の本日掲示状態 継承伝搬 (純関数) の検証。
 *
 * 「その他」は学年を持たないので、サイネージ階層フォールバック class → department → school と同規約で
 * active 判定する (grade 段はスキップ)。`computeTodayActiveClasses` (学年ツリー版) では扱えないため
 * 専用関数を持つ。
 */

const scopes = (parts: Partial<Parameters<typeof computeTodayActiveOtherClasses>[0]>) => ({
  school: false,
  departmentIds: [],
  gradeIds: [],
  classIds: [],
  ...parts,
});

const SCHOOL_OTHER: OtherClass = { id: "c-school", name: "玄関", departmentId: null };
const DEPT_OTHER: OtherClass = { id: "c-dept", name: "実習棟入口", departmentId: "d1" };

describe("computeTodayActiveOtherClasses", () => {
  it("自クラス scope に中身があれば active", () => {
    const out = computeTodayActiveOtherClasses(scopes({ classIds: ["c-school"] }), [SCHOOL_OTHER]);
    expect(out["c-school"]).toBe(true);
  });

  it("学校 scope に中身があれば全「その他」が active", () => {
    const out = computeTodayActiveOtherClasses(scopes({ school: true }), [
      SCHOOL_OTHER,
      DEPT_OTHER,
    ]);
    expect(out["c-school"]).toBe(true);
    expect(out["c-dept"]).toBe(true);
  });

  it("親学科 scope は department_id を持つ「その他」にだけ伝搬する", () => {
    const out = computeTodayActiveOtherClasses(scopes({ departmentIds: ["d1"] }), [
      SCHOOL_OTHER,
      DEPT_OTHER,
    ]);
    // 学科配下の「その他」は active、学校直下 (department_id NULL) は学科 scope の影響を受けない。
    expect(out["c-dept"]).toBe(true);
    expect(out["c-school"]).toBe(false);
  });

  it("grade scope は「その他」に影響しない（学年段はスキップ）", () => {
    const out = computeTodayActiveOtherClasses(scopes({ gradeIds: ["g1"] }), [SCHOOL_OTHER]);
    expect(out["c-school"]).toBe(false);
  });

  it("該当 scope が無ければ inactive", () => {
    const out = computeTodayActiveOtherClasses(scopes({}), [SCHOOL_OTHER, DEPT_OTHER]);
    expect(out["c-school"]).toBe(false);
    expect(out["c-dept"]).toBe(false);
  });

  it("空入力でも安全 (空 Record)", () => {
    expect(computeTodayActiveOtherClasses(scopes({}), [])).toEqual({});
  });
});
