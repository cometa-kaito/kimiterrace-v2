import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../lib/auth/session";
import {
  toHubActor,
  validateClassInput,
  validateDepartmentInput,
  validateGradeInput,
  validateOtherLocationInput,
  validateOtherLocationUpdate,
  validateReorder,
} from "../../lib/school-admin/hub-core";

const UUID = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const SYS_UID = "33333333-3333-4333-8333-333333333333";

describe("toHubActor", () => {
  const base: AuthUser = { uid: "u1", role: "school_admin", schoolId: UUID };

  it("school_admin: 自校 + userRef=uid (users.id FK) + identityUid=null (従来挙動)", () => {
    expect(toHubActor(base)).toEqual({
      actorUserId: "u1",
      userRef: "u1",
      identityUid: null,
      schoolId: UUID,
    });
  });

  it("school_admin: targetSchoolId を渡しても無視し自校に固定 (越境防止)", () => {
    // 他校 id を渡してもセッションの自校 (UUID) に張り付く = クライアント由来 id で越境させない。
    expect(toHubActor(base, OTHER)).toEqual({
      actorUserId: "u1",
      userRef: "u1",
      identityUid: null,
      schoolId: UUID,
    });
  });

  it("school_admin: 自校 null は null (テナント未割当)", () => {
    expect(toHubActor({ ...base, schoolId: null })).toBeNull();
  });

  it("system_admin: 対象校未指定は null (呼出側が forbidden 化)", () => {
    expect(toHubActor({ uid: SYS_UID, role: "system_admin", schoolId: null })).toBeNull();
  });

  it("system_admin: 対象校が非 UUID は null", () => {
    expect(
      toHubActor({ uid: SYS_UID, role: "system_admin", schoolId: null }, "not-uuid"),
    ).toBeNull();
  });

  it("system_admin: 対象校指定で userRef=null (users 行が無い) + identityUid=uid", () => {
    expect(toHubActor({ uid: SYS_UID, role: "system_admin", schoolId: null }, UUID)).toEqual({
      actorUserId: SYS_UID,
      userRef: null,
      identityUid: SYS_UID,
      schoolId: UUID,
    });
  });

  it("system_admin: actor の schoolId は対象校 (セッション schoolId に依存しない)", () => {
    // セッションに別 schoolId があっても、明示の対象校 (UUID) が actor の schoolId になる。
    const actor = toHubActor({ uid: SYS_UID, role: "system_admin", schoolId: OTHER }, UUID);
    expect(actor?.schoolId).toBe(UUID);
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
  const ok = { gradeId: UUID, name: "A組", grade: 1 };
  it("正常", () => {
    expect(validateClassInput(ok)).toEqual({ ok: true, value: ok });
  });
  it("gradeId 不正は拒否", () => {
    expect(validateClassInput({ ...ok, gradeId: "x" }).ok).toBe(false);
  });
  it("学年数の域外は拒否 (1..12)", () => {
    expect(validateClassInput({ ...ok, grade: 0 }).ok).toBe(false);
    expect(validateClassInput({ ...ok, grade: 13 }).ok).toBe(false);
  });
  it("非整数の学年数は拒否", () => {
    expect(validateClassInput({ ...ok, grade: 1.5 }).ok).toBe(false);
  });
});

describe("validateOtherLocationInput（その他=学年なし設置場所）", () => {
  it("正常: name trim + departmentId 任意（未指定は学校直下=null）", () => {
    expect(validateOtherLocationInput({ name: "  玄関 " })).toEqual({
      ok: true,
      value: { name: "玄関", departmentId: null },
    });
  });
  it("departmentId 指定時は UUID（学科配下）/ 不正は拒否", () => {
    const r = validateOtherLocationInput({ name: "廊下", departmentId: UUID });
    expect(r.ok && r.value.departmentId).toBe(UUID);
    expect(validateOtherLocationInput({ name: "廊下", departmentId: "x" }).ok).toBe(false);
  });
  it("空名称 / 65 文字超は不正", () => {
    expect(validateOtherLocationInput({ name: "  " }).ok).toBe(false);
    expect(validateOtherLocationInput({ name: "あ".repeat(65) }).ok).toBe(false);
  });
  it("学年概念を持たない: 余剰の gradeId/grade は無視し name/departmentId のみ採る", () => {
    const r = validateOtherLocationInput({
      name: "職員室前",
      gradeId: UUID,
      grade: 3,
    } as never);
    expect(r).toEqual({ ok: true, value: { name: "職員室前", departmentId: null } });
  });
});

describe("validateOtherLocationUpdate", () => {
  it("正常: id + name + departmentId（学科の付替も許す）", () => {
    expect(validateOtherLocationUpdate({ id: UUID, name: "正門", departmentId: OTHER })).toEqual({
      ok: true,
      value: { id: UUID, name: "正門", departmentId: OTHER },
    });
  });
  it("id 不正は拒否（DB に到達させない）", () => {
    expect(validateOtherLocationUpdate({ id: "x", name: "正門" }).ok).toBe(false);
  });
  it("空名称は拒否", () => {
    expect(validateOtherLocationUpdate({ id: UUID, name: " " }).ok).toBe(false);
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
