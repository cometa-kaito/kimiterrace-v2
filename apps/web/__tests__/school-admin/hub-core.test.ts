import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../lib/auth/session";
import {
  toHubActor,
  validateClassInput,
  validateDepartmentInput,
  validateGradeInput,
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
