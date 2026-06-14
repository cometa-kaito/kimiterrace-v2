import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../lib/auth/session";
import {
  classDupKey,
  nextDuplicationYears,
  planNextYearDuplication,
  toHubActor,
  validateClassInput,
  validateDepartmentInput,
  validateGradeInput,
  validateReorder,
} from "../../lib/school-admin/hub-core";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("toHubActor", () => {
  const base: AuthUser = { uid: "u1", role: "school_admin", schoolId: UUID };
  it("school_id があれば actor を返す", () => {
    expect(toHubActor(base)).toEqual({ userId: "u1", schoolId: UUID });
  });
  it("school_id null (テナント未選択 system_admin 等) は null", () => {
    expect(toHubActor({ ...base, role: "system_admin", schoolId: null })).toBeNull();
  });
});

describe("validateDepartmentInput", () => {
  it("正常: 名称 trim + displayOrder 既定 0", () => {
    const r = validateDepartmentInput({ name: "  機械科 " });
    expect(r).toEqual({ ok: true, value: { name: "機械科", displayOrder: 0 } });
  });
  it("空名称は不正", () => {
    expect(validateDepartmentInput({ name: "   " }).ok).toBe(false);
  });
  it("65 文字超は不正", () => {
    expect(validateDepartmentInput({ name: "あ".repeat(65) }).ok).toBe(false);
  });
  it("負の表示順は不正", () => {
    expect(validateDepartmentInput({ name: "x", displayOrder: -1 }).ok).toBe(false);
  });
  it("文字列の数値は受理", () => {
    const r = validateDepartmentInput({ name: "x", displayOrder: "3" });
    expect(r.ok && r.value.displayOrder).toBe(3);
  });
});

describe("validateGradeInput", () => {
  it("正常: hasClasses 既定 true / departmentId 任意", () => {
    const r = validateGradeInput({ name: "1年" });
    expect(r).toEqual({
      ok: true,
      value: { name: "1年", displayOrder: 0, hasClasses: true, departmentId: null },
    });
  });
  it("hasClasses=false を尊重", () => {
    const r = validateGradeInput({ name: "1年", hasClasses: false });
    expect(r.ok && r.value.hasClasses).toBe(false);
  });
  it("departmentId 指定時は UUID 必須", () => {
    expect(validateGradeInput({ name: "1年", departmentId: "not-uuid" }).ok).toBe(false);
    const r = validateGradeInput({ name: "1年", departmentId: UUID });
    expect(r.ok && r.value.departmentId).toBe(UUID);
  });
  it("空文字 departmentId は null 扱い", () => {
    const r = validateGradeInput({ name: "1年", departmentId: "" });
    expect(r.ok && r.value.departmentId).toBeNull();
  });
});

describe("validateClassInput", () => {
  const ok = { gradeId: UUID, name: "A組", academicYear: 2026, grade: 1 };
  it("正常", () => {
    expect(validateClassInput(ok)).toEqual({ ok: true, value: ok });
  });
  it("gradeId 不正は拒否", () => {
    expect(validateClassInput({ ...ok, gradeId: "x" }).ok).toBe(false);
  });
  it("年度域外は拒否", () => {
    expect(validateClassInput({ ...ok, academicYear: 1999 }).ok).toBe(false);
    expect(validateClassInput({ ...ok, academicYear: 2101 }).ok).toBe(false);
  });
  it("学年数の域外は拒否 (1..12)", () => {
    expect(validateClassInput({ ...ok, grade: 0 }).ok).toBe(false);
    expect(validateClassInput({ ...ok, grade: 13 }).ok).toBe(false);
  });
  it("非整数の年度は拒否", () => {
    expect(validateClassInput({ ...ok, academicYear: 2026.5 }).ok).toBe(false);
  });
});

describe("planNextYearDuplication（新年度へ複製の対象算出）", () => {
  it("クラスが無ければ null", () => {
    expect(planNextYearDuplication([])).toBeNull();
  });

  it("最新年度のクラスを翌年度へ複製（gradeId=null は除外・旧年度は対象外）", () => {
    const plan = planNextYearDuplication([
      { gradeId: "g1", name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: "g1", name: "2組", grade: 1, academicYear: 2026 },
      { gradeId: null, name: "未割当", grade: 1, academicYear: 2026 },
      { gradeId: "g0", name: "旧", grade: 1, academicYear: 2025 },
    ]);
    expect(plan?.sourceYear).toBe(2026);
    expect(plan?.targetYear).toBe(2027);
    expect(plan?.toCreate).toEqual([
      { gradeId: "g1", name: "1組", grade: 1, academicYear: 2027 },
      { gradeId: "g1", name: "2組", grade: 1, academicYear: 2027 },
    ]);
  });

  it("source は常に最新年度（複数年度が混在しても最大年度を採る）", () => {
    const plan = planNextYearDuplication([
      { gradeId: "g1", name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: "g1", name: "A組", grade: 1, academicYear: 2027 },
    ]);
    expect(plan?.sourceYear).toBe(2027);
    expect(plan?.targetYear).toBe(2028);
    expect(plan?.toCreate).toEqual([{ gradeId: "g1", name: "A組", grade: 1, academicYear: 2028 }]);
  });

  it("既存 target のクラス (gradeId,name) は除外する（冪等化・並行/再実行の防御）", () => {
    const rows = [
      { gradeId: "g1", name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: "g1", name: "2組", grade: 1, academicYear: 2026 },
    ];
    const plan = planNextYearDuplication(rows, new Set([classDupKey("g1", "1組")]));
    // 1組 は target に既存ゆえ除外、2組 のみ複製対象。
    expect(plan?.toCreate).toEqual([{ gradeId: "g1", name: "2組", grade: 1, academicYear: 2027 }]);
  });

  it("target に全クラスが既存なら toCreate は空（重複生成しない）", () => {
    const rows = [
      { gradeId: "g1", name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: "g1", name: "2組", grade: 1, academicYear: 2026 },
    ];
    const existing = new Set([classDupKey("g1", "1組"), classDupKey("g1", "2組")]);
    expect(planNextYearDuplication(rows, existing)?.toCreate).toEqual([]);
  });

  it("同名でも別学年(gradeId)なら除外しない（unique 鍵は school×year×grade×name）", () => {
    const rows = [
      { gradeId: "g1", name: "1組", grade: 1, academicYear: 2026 },
      { gradeId: "g2", name: "1組", grade: 2, academicYear: 2026 },
    ];
    const plan = planNextYearDuplication(rows, new Set([classDupKey("g1", "1組")]));
    expect(plan?.toCreate).toEqual([{ gradeId: "g2", name: "1組", grade: 2, academicYear: 2027 }]);
  });

  it("existingTargetKeys 省略時は従来どおり全件（除外なし）", () => {
    const plan = planNextYearDuplication([
      { gradeId: "g1", name: "1組", grade: 1, academicYear: 2026 },
    ]);
    expect(plan?.toCreate).toHaveLength(1);
  });
});

describe("nextDuplicationYears", () => {
  it("空配列は null", () => {
    expect(nextDuplicationYears([])).toBeNull();
  });
  it("最新年度を source、+1 を target にする（混在しても最大年度）", () => {
    expect(
      nextDuplicationYears([
        { gradeId: "g1", name: "1組", grade: 1, academicYear: 2025 },
        { gradeId: "g1", name: "A組", grade: 1, academicYear: 2027 },
      ]),
    ).toEqual({ sourceYear: 2027, targetYear: 2028 });
  });
});

describe("classDupKey", () => {
  const uuidA = "11111111-1111-1111-1111-111111111111";
  const uuidB = "22222222-2222-2222-2222-222222222222";
  it("同一 (gradeId,name) は同キー / 異なれば別キー", () => {
    expect(classDupKey(uuidA, "1組")).toBe(classDupKey(uuidA, "1組"));
    expect(classDupKey(uuidA, "1組")).not.toBe(classDupKey(uuidB, "1組"));
    expect(classDupKey(uuidA, "1組")).not.toBe(classDupKey(uuidA, "2組"));
  });
  it("空白を含む name でも別ペアと衝突しない（gradeId は UUID で境界一意）", () => {
    expect(classDupKey(uuidA, "a b")).not.toBe(classDupKey(uuidB, "a b"));
    expect(classDupKey(uuidA, "a b")).not.toBe(classDupKey(uuidA, "a  b"));
  });
});

describe("validateReorder", () => {
  const u1 = "11111111-1111-1111-1111-111111111111";
  const u2 = "22222222-2222-2222-2222-222222222222";

  it("entity（department/grade）と UUID 配列を受理する", () => {
    expect(validateReorder({ entity: "department", orderedIds: [u1, u2] })).toEqual({
      ok: true,
      value: { entity: "department", orderedIds: [u1, u2] },
    });
    expect(validateReorder({ entity: "grade", orderedIds: [u1] }).ok).toBe(true);
  });

  it("不正 entity / 空配列 / 非UUID / 重複 / 過大件数 を弾く", () => {
    expect(validateReorder({ entity: "class", orderedIds: [u1] }).ok).toBe(false);
    expect(validateReorder({ entity: "department", orderedIds: [] }).ok).toBe(false);
    expect(validateReorder({ entity: "department", orderedIds: ["x"] }).ok).toBe(false);
    expect(validateReorder({ entity: "department", orderedIds: [u1, u1] }).ok).toBe(false);
    expect(validateReorder({ entity: "department", orderedIds: Array(1001).fill(u1) }).ok).toBe(
      false,
    );
  });
});
