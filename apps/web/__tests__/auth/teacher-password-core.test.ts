import { describe, expect, it } from "vitest";
import {
  MAX_TEACHER_PASSWORD_LENGTH,
  MIN_TEACHER_PASSWORD_LENGTH,
  validateTeacherPasswordPolicy,
} from "@/lib/auth/teacher-password-core";

/**
 * ADR-032: 教員共通パスワードのポリシー検証（4 文字以上、上限以内）。
 */

describe("validateTeacherPasswordPolicy", () => {
  it("最小長 4 文字を許容する（ユーザー判断）", () => {
    expect(MIN_TEACHER_PASSWORD_LENGTH).toBe(4);
    expect(validateTeacherPasswordPolicy("1234").ok).toBe(true);
    expect(validateTeacherPasswordPolicy("abcd").ok).toBe(true);
  });

  it("4 文字未満は拒否", () => {
    const r = validateTeacherPasswordPolicy("123");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("4");
    }
  });

  it("空文字・非文字列は拒否", () => {
    expect(validateTeacherPasswordPolicy("").ok).toBe(false);
    expect(validateTeacherPasswordPolicy(undefined).ok).toBe(false);
    expect(validateTeacherPasswordPolicy(1234 as unknown).ok).toBe(false);
  });

  it("上限超過は拒否", () => {
    const tooLong = "a".repeat(MAX_TEACHER_PASSWORD_LENGTH + 1);
    expect(validateTeacherPasswordPolicy(tooLong).ok).toBe(false);
    expect(validateTeacherPasswordPolicy("a".repeat(MAX_TEACHER_PASSWORD_LENGTH)).ok).toBe(true);
  });
});
