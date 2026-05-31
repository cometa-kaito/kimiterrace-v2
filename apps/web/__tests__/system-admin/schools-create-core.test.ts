import { describe, expect, it } from "vitest";
import { validateSchoolCreate } from "../../lib/system-admin/schools-core";

/**
 * #48-L3 (#123): validateSchoolCreate の純粋検証テスト。
 * 規則は update と共通だが id を要求しない。name/prefecture 必須・code 任意・mode は enum のみ。
 */
describe("validateSchoolCreate", () => {
  const valid = {
    name: "岐南工業高校",
    prefecture: "岐阜県",
    code: "G001",
    hierarchyMode: "department",
  };

  it("妥当な入力は正規化して通す (前後空白除去)", () => {
    const res = validateSchoolCreate({ ...valid, name: "  岐南工業高校  " });
    expect(res).toEqual({
      ok: true,
      value: {
        name: "岐南工業高校",
        prefecture: "岐阜県",
        code: "G001",
        hierarchyMode: "department",
      },
    });
  });

  it("code 未指定/空は null (任意)", () => {
    expect(validateSchoolCreate({ ...valid, code: "" })).toMatchObject({
      ok: true,
      value: { code: null },
    });
    expect(validateSchoolCreate({ ...valid, code: undefined })).toMatchObject({
      ok: true,
      value: { code: null },
    });
  });

  it("空の学校名は invalid", () => {
    expect(validateSchoolCreate({ ...valid, name: "  " })).toMatchObject({ ok: false });
  });

  it("空の都道府県は invalid", () => {
    expect(validateSchoolCreate({ ...valid, prefecture: "" })).toMatchObject({ ok: false });
  });

  it("学校名が 200 文字超は invalid", () => {
    expect(validateSchoolCreate({ ...valid, name: "あ".repeat(201) })).toMatchObject({ ok: false });
  });

  it("学校コードが 32 文字超は invalid", () => {
    expect(validateSchoolCreate({ ...valid, code: "x".repeat(33) })).toMatchObject({ ok: false });
  });

  it("未知の階層モードは invalid", () => {
    expect(validateSchoolCreate({ ...valid, hierarchyMode: "grade" })).toMatchObject({ ok: false });
    expect(validateSchoolCreate({ ...valid, hierarchyMode: undefined })).toMatchObject({
      ok: false,
    });
  });
});
