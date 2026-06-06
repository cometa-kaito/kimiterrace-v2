import { describe, expect, it } from "vitest";
import {
  HIERARCHY_MODES,
  collectSchoolFieldErrors,
  hasSchoolFieldErrors,
  isUuid,
  validateSchoolUpdate,
} from "../../lib/system-admin/schools-core";

/**
 * #48-L (#123): 学校編集の入力検証 (pure) を固定する。Server Action / RLS に到達する前の
 * 第一防衛線。全置換 (id + name + prefecture + code + hierarchyMode) を検証する。
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";

const valid = {
  id: SCHOOL_ID,
  name: "岐南工業高校",
  prefecture: "岐阜県",
  code: "G001",
  hierarchyMode: "department" as const,
};

describe("isUuid", () => {
  it("UUID 形式のみ true", () => {
    expect(isUuid(SCHOOL_ID)).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("HIERARCHY_MODES", () => {
  it("class / department の 2 値 (DB enum と一致)", () => {
    expect([...HIERARCHY_MODES]).toEqual(["class", "department"]);
  });
});

describe("validateSchoolUpdate", () => {
  it("正常系: 値をトリムして返す", () => {
    const res = validateSchoolUpdate({ ...valid, name: "  岐南工業高校  ", code: " G001 " });
    expect(res).toEqual({
      ok: true,
      value: {
        id: SCHOOL_ID,
        name: "岐南工業高校",
        prefecture: "岐阜県",
        code: "G001",
        hierarchyMode: "department",
      },
    });
  });

  it("不正な id は invalid", () => {
    const res = validateSchoolUpdate({ ...valid, id: "nope" });
    expect(res).toMatchObject({ ok: false });
  });

  it("空の学校名は invalid", () => {
    expect(validateSchoolUpdate({ ...valid, name: "   " })).toMatchObject({ ok: false });
  });

  it("200 文字超の学校名は invalid", () => {
    expect(validateSchoolUpdate({ ...valid, name: "あ".repeat(201) })).toMatchObject({ ok: false });
  });

  it("空の都道府県は invalid", () => {
    expect(validateSchoolUpdate({ ...valid, prefecture: "" })).toMatchObject({ ok: false });
  });

  it("code は任意: 空文字は null に正規化して ok", () => {
    const res = validateSchoolUpdate({ ...valid, code: "" });
    expect(res).toEqual({ ok: true, value: { ...valid, code: null } });
  });

  it("code は任意: 未指定 (undefined) も null に正規化して ok", () => {
    const res = validateSchoolUpdate({ ...valid, code: undefined });
    expect(res).toMatchObject({ ok: true, value: { code: null } });
  });

  it("32 文字超の code は invalid", () => {
    expect(validateSchoolUpdate({ ...valid, code: "x".repeat(33) })).toMatchObject({ ok: false });
  });

  it("未知の階層モードは invalid", () => {
    expect(validateSchoolUpdate({ ...valid, hierarchyMode: "grade" })).toMatchObject({ ok: false });
    expect(validateSchoolUpdate({ ...valid, hierarchyMode: undefined })).toMatchObject({
      ok: false,
    });
  });
});

describe("collectSchoolFieldErrors (FormField 用の項目別検証)", () => {
  it("正常系: エラー無しは空オブジェクト", () => {
    expect(
      collectSchoolFieldErrors({ name: "岐南工業高校", prefecture: "岐阜県", code: "G001" }),
    ).toEqual({});
    // code は任意: 空文字/未指定でもエラーにしない。
    expect(collectSchoolFieldErrors({ name: "A", prefecture: "B", code: "" })).toEqual({});
    expect(collectSchoolFieldErrors({ name: "A", prefecture: "B" })).toEqual({});
  });

  it("空の学校名は name エラー (trim 後 0 文字も)", () => {
    expect(collectSchoolFieldErrors({ name: "   ", prefecture: "岐阜県" }).name).toMatch(/学校名/);
  });

  it("空の都道府県は prefecture エラー", () => {
    expect(collectSchoolFieldErrors({ name: "A", prefecture: "" }).prefecture).toMatch(/都道府県/);
  });

  it("200 文字超の学校名 / 32 文字超の都道府県・code はそれぞれエラー", () => {
    const errors = collectSchoolFieldErrors({
      name: "あ".repeat(201),
      prefecture: "い".repeat(33),
      code: "x".repeat(33),
    });
    expect(errors.name).toBeTruthy();
    expect(errors.prefecture).toBeTruthy();
    expect(errors.code).toBeTruthy();
  });

  it("複数項目が空なら複数キーが立つ", () => {
    const errors = collectSchoolFieldErrors({ name: "", prefecture: "" });
    expect(Object.keys(errors).sort()).toEqual(["name", "prefecture"]);
  });

  it("hasSchoolFieldErrors はエラー有無を判定する", () => {
    expect(hasSchoolFieldErrors({})).toBe(false);
    expect(hasSchoolFieldErrors({ name: "x" })).toBe(true);
  });
});
