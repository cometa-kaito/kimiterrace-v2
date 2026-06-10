import { describe, expect, it } from "vitest";
import {
  deterministicUuid,
  isPasswordRejectedError,
  sharedTeacherUid,
  teacherAccountEmail,
} from "@/lib/auth/teacher-account";

/**
 * ADR-032: 共通教員アカウントの決定的識別子（uid/email）の純ロジック検証。
 * provisioning（admin SDK）は staging/CI 実機で裏取り。ここでは決定性・形式・一意写像を固定する。
 * uid は SHA-256 ベースの UUIDv8 形式（SHA-1 weak-crypto を避ける、teacher-account.ts 参照）。
 */

const SCHOOL_A = "11111111-1111-4111-8111-111111111111";
const SCHOOL_B = "22222222-2222-4222-8222-222222222222";

describe("deterministicUuid", () => {
  const NS = "9b6f6e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";

  it("決定的（同じ入力は同じ UUID）", () => {
    expect(deterministicUuid("x", NS)).toBe(deterministicUuid("x", NS));
  });

  it("入力（name / namespace）が違えば異なる", () => {
    expect(deterministicUuid("x", NS)).not.toBe(deterministicUuid("y", NS));
    expect(deterministicUuid("x", NS)).not.toBe(
      deterministicUuid("x", "00000000-0000-0000-0000-000000000000"),
    );
  });

  it("version 8（custom）+ variant の UUID 形式", () => {
    expect(deterministicUuid("x", NS)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("sharedTeacherUid", () => {
  it("学校ごとに決定的（再計算で一致）", () => {
    expect(sharedTeacherUid(SCHOOL_A)).toBe(sharedTeacherUid(SCHOOL_A));
  });

  it("学校が異なれば uid も異なる（一意写像）", () => {
    expect(sharedTeacherUid(SCHOOL_A)).not.toBe(sharedTeacherUid(SCHOOL_B));
  });

  it("session 検証が要求する UUID 形式（localId==users.id）", () => {
    expect(sharedTeacherUid(SCHOOL_A)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("teacherAccountEmail", () => {
  it("ローカル部はハイフン除去で英数字（IdP が受ける形式）", () => {
    const email = teacherAccountEmail(SCHOOL_A);
    expect(email).toBe("t-11111111111141118111111111111111@teacher.kimiterrace.invalid");
    expect(email).not.toContain("-".repeat(1) + "1111-"); // ハイフンが local 部に残らない
  });

  it("学校ごとに異なる email", () => {
    expect(teacherAccountEmail(SCHOOL_A)).not.toBe(teacherAccountEmail(SCHOOL_B));
  });

  it("送信されない予約 TLD .invalid を使う", () => {
    expect(teacherAccountEmail(SCHOOL_A).endsWith(".invalid")).toBe(true);
  });
});

describe("isPasswordRejectedError", () => {
  it("auth/invalid-password と auth/weak-password は true（設定者が直せる入力エラー）", () => {
    expect(isPasswordRejectedError({ code: "auth/invalid-password" })).toBe(true);
    expect(isPasswordRejectedError({ code: "auth/weak-password" })).toBe(true);
  });

  it("それ以外のコード / 非エラー値は false（権限・インフラ起因は再 throw させるため分類しない）", () => {
    expect(isPasswordRejectedError({ code: "auth/email-already-exists" })).toBe(false);
    expect(isPasswordRejectedError({ code: "auth/internal-error" })).toBe(false);
    expect(isPasswordRejectedError(new Error("plain"))).toBe(false);
    expect(isPasswordRejectedError(null)).toBe(false);
    expect(isPasswordRejectedError(undefined)).toBe(false);
    expect(isPasswordRejectedError("auth/invalid-password")).toBe(false);
  });
});
