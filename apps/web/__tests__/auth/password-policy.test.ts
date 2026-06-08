import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_CHANGE_ROLES,
  validateNewPassword,
} from "../../lib/auth/password-policy";

/**
 * パスワード検証 (リセット / 変更フォーム共通) の純ロジック検証。
 */
describe("validateNewPassword", () => {
  it(`${MIN_PASSWORD_LENGTH} 文字未満は不可`, () => {
    const r = validateNewPassword("short", "short");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("確認が一致しないと不可 (長さは満たしていても)", () => {
    const r = validateNewPassword("longenough1", "longenough2");
    expect(r).toEqual({ ok: false, message: "確認用パスワードが一致しません。" });
  });

  it("長さ十分 + 一致なら ok", () => {
    expect(validateNewPassword("longenough1", "longenough1")).toEqual({ ok: true });
  });

  it(`境界: ちょうど ${MIN_PASSWORD_LENGTH} 文字は ok`, () => {
    const exact = "a".repeat(MIN_PASSWORD_LENGTH);
    expect(validateNewPassword(exact, exact)).toEqual({ ok: true });
  });

  it(`境界: ${MIN_PASSWORD_LENGTH - 1} 文字は不可`, () => {
    const tooShort = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validateNewPassword(tooShort, tooShort).ok).toBe(false);
  });
});

describe("PASSWORD_CHANGE_ROLES", () => {
  it("個人 email/password アカウント (system_admin / school_admin) のみ。teacher (学校共通PW) は含めない", () => {
    expect([...PASSWORD_CHANGE_ROLES]).toEqual(["system_admin", "school_admin"]);
    expect((PASSWORD_CHANGE_ROLES as readonly string[]).includes("teacher")).toBe(false);
  });
});
