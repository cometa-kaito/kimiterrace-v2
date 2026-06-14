import { describe, expect, it } from "vitest";
import { computeTodayActiveClasses } from "../../lib/school-admin/hub-queries";

/**
 * #48-K3 PR2: computeTodayActiveClasses（本日掲示状態の継承伝搬）の純関数検証。
 * DB 依存の getTodayDailyDataScopes は実 PG が要るため hub-actions.test.ts 系に委ね、ここは
 * 「class > grade > department > school のどの scope の本日入力でも配下クラスへ正しく伝搬するか」
 * だけを固める。
 */

const grades = [
  {
    id: "g1",
    name: "1年",
    displayOrder: 0,
    hasClasses: true,
    departmentId: "d1",
    classes: [
      { id: "c1", name: "1組", academicYear: 2026, grade: 1 },
      { id: "c2", name: "2組", academicYear: 2026, grade: 1 },
    ],
  },
  {
    id: "g2",
    name: "2年",
    displayOrder: 0,
    hasClasses: true,
    departmentId: "d2",
    classes: [{ id: "c3", name: "A組", academicYear: 2026, grade: 2 }],
  },
];

describe("computeTodayActiveClasses（本日状態の継承伝搬）", () => {
  it("class scope は当該クラスのみ active", () => {
    expect(
      computeTodayActiveClasses(
        { school: false, departmentIds: [], gradeIds: [], classIds: ["c1"] },
        grades,
      ),
    ).toEqual({ c1: true, c2: false, c3: false });
  });

  it("grade scope は配下クラスを active", () => {
    expect(
      computeTodayActiveClasses(
        { school: false, departmentIds: [], gradeIds: ["g1"], classIds: [] },
        grades,
      ),
    ).toEqual({ c1: true, c2: true, c3: false });
  });

  it("department scope は配下学年のクラスを active", () => {
    expect(
      computeTodayActiveClasses(
        { school: false, departmentIds: ["d2"], gradeIds: [], classIds: [] },
        grades,
      ),
    ).toEqual({ c1: false, c2: false, c3: true });
  });

  it("school scope は全クラス active", () => {
    expect(
      computeTodayActiveClasses(
        { school: true, departmentIds: [], gradeIds: [], classIds: [] },
        grades,
      ),
    ).toEqual({ c1: true, c2: true, c3: true });
  });
});
