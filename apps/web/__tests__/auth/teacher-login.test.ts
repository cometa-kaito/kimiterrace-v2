import {
  MAX_AUTODETECT_SCHOOLS,
  authenticateTeacherByPassword,
  selectTeacherLoginMatch,
} from "@/lib/auth/teacher-login";
import { describe, expect, it, vi } from "vitest";

/**
 * ADR-032 追補: 教員ログインの「学校選択レス = 入力パスワードで学校自動判定」のコアロジック。
 *
 * IdP / DB に触れない純ロジック（`selectTeacherLoginMatch`）と、依存注入で IdP/DB を fake 化した
 * オーケストレーション（`authenticateTeacherByPassword`）を決定的に検証する。テナント越境防止の要は
 * 「2 校以上一致（パスワード重複）は `ambiguous` で拒否」「1 リクエストの試行先は MAX で頭打ち」。
 */

describe("selectTeacherLoginMatch（純関数）", () => {
  it("有効校ゼロ（results 空）→ no_schools", () => {
    expect(selectTeacherLoginMatch([])).toEqual({ ok: false, reason: "no_schools" });
  });

  it("有効校ありだが全不一致 → no_match", () => {
    expect(
      selectTeacherLoginMatch([
        { schoolId: "s1", idToken: null },
        { schoolId: "s2", idToken: null },
      ]),
    ).toEqual({ ok: false, reason: "no_match" });
  });

  it("ちょうど 1 校一致 → その学校で ok（idToken を引き継ぐ）", () => {
    expect(
      selectTeacherLoginMatch([
        { schoolId: "s1", idToken: null },
        { schoolId: "s2", idToken: "tok-s2" },
      ]),
    ).toEqual({ ok: true, schoolId: "s2", idToken: "tok-s2" });
  });

  it("2 校以上一致（学校間パスワード重複）→ ambiguous（一致校 id を列挙、越境防止で拒否）", () => {
    expect(
      selectTeacherLoginMatch([
        { schoolId: "s1", idToken: "tok-s1" },
        { schoolId: "s2", idToken: null },
        { schoolId: "s3", idToken: "tok-s3" },
      ]),
    ).toEqual({ ok: false, reason: "ambiguous", schoolIds: ["s1", "s3"] });
  });
});

describe("authenticateTeacherByPassword（依存注入で IdP/DB を fake）", () => {
  it("有効校ゼロ → no_schools（IdP を一度も叩かない）", async () => {
    const signIn = vi.fn(async () => "tok");
    const result = await authenticateTeacherByPassword("pw", {
      listSchools: async () => [],
      signIn,
    });
    expect(result).toEqual({ ok: false, reason: "no_schools" });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("1 校・正しいパスワード → ok", async () => {
    const result = await authenticateTeacherByPassword("pw", {
      listSchools: async () => [{ id: "s1" }],
      signIn: async (schoolId, password) =>
        schoolId === "s1" && password === "pw" ? "tok-s1" : null,
    });
    expect(result).toEqual({ ok: true, schoolId: "s1", idToken: "tok-s1" });
  });

  it("1 校・誤ったパスワード → no_match", async () => {
    const result = await authenticateTeacherByPassword("wrong", {
      listSchools: async () => [{ id: "s1" }],
      signIn: async (_schoolId, password) => (password === "pw" ? "tok-s1" : null),
    });
    expect(result).toEqual({ ok: false, reason: "no_match" });
  });

  it("複数校・1 校だけ一致 → その学校で ok（自動判定）", async () => {
    const result = await authenticateTeacherByPassword("pw-of-s2", {
      listSchools: async () => [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      // s2 の共通パスワードだけ "pw-of-s2"。
      signIn: async (schoolId, password) =>
        schoolId === "s2" && password === "pw-of-s2" ? "tok-s2" : null,
    });
    expect(result).toEqual({ ok: true, schoolId: "s2", idToken: "tok-s2" });
  });

  it("複数校・パスワード重複（2 校一致）→ ambiguous（ログイン拒否）", async () => {
    const result = await authenticateTeacherByPassword("dup", {
      listSchools: async () => [{ id: "s1" }, { id: "s2" }],
      // 両校とも同じ共通パスワード "dup" = 重複。
      signIn: async (schoolId) => `tok-${schoolId}`,
    });
    expect(result).toEqual({ ok: false, reason: "ambiguous", schoolIds: ["s1", "s2"] });
  });

  it("有効校が上限超 → 先頭 MAX 校のみ試行（IdP 呼び出し増幅の安全弁）", async () => {
    const schools = Array.from({ length: MAX_AUTODETECT_SCHOOLS + 5 }, (_, i) => ({
      id: `s${i}`,
    }));
    const tried: string[] = [];
    const result = await authenticateTeacherByPassword("pw", {
      listSchools: async () => schools,
      signIn: async (schoolId) => {
        tried.push(schoolId);
        // 上限を超えた位置（先頭 MAX 校に含まれない）にだけ一致を仕込む。
        return schoolId === `s${MAX_AUTODETECT_SCHOOLS + 1}` ? "tok" : null;
      },
    });
    // 試行は MAX 校で頭打ち。上限外の一致は届かず no_match。
    expect(tried).toHaveLength(MAX_AUTODETECT_SCHOOLS);
    expect(tried).not.toContain(`s${MAX_AUTODETECT_SCHOOLS + 1}`);
    expect(result).toEqual({ ok: false, reason: "no_match" });
  });
});
