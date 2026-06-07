import { describe, expect, it } from "vitest";
import { sharedTeacherUid, teacherAccountEmail, uuidv5 } from "@/lib/auth/teacher-account";

/**
 * ADR-032: 共通教員アカウントの決定的識別子（uid/email）の純ロジック検証。
 * provisioning（admin SDK）は staging/CI 実機で裏取り。ここでは決定性・形式・一意写像を固定する。
 */

const SCHOOL_A = "11111111-1111-4111-8111-111111111111";
const SCHOOL_B = "22222222-2222-4222-8222-222222222222";

describe("uuidv5", () => {
  const NS = "9b6f6e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";

  it("RFC 4122 既知ベクトル（DNS 名前空間の 'www.example.com'）に一致する", () => {
    // RFC 4122 / 既知の v5 ベクトル。実装の正しさを外部基準で固定する。
    const DNS_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(uuidv5("www.example.com", DNS_NS)).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("決定的（同じ入力は同じ UUID）", () => {
    expect(uuidv5("x", NS)).toBe(uuidv5("x", NS));
  });

  it("version 5 + variant の UUID 形式", () => {
    expect(uuidv5("x", NS)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
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
