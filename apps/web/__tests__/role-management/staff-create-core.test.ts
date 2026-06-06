import { describe, expect, it } from "vitest";
import {
  collectStaffCreateFieldErrors,
  hasStaffCreateFieldErrors,
  validateStaffCreate,
} from "../../lib/role-management/staff-create-core";

/**
 * F11 (#508): 教職員発行の入力検証 (pure・単一ソース)。client の項目別検証と server の single-error
 * 検証が同じ規則・同じメッセージであることを固定する (member-actions.ts の inline 検証から抽出)。
 */

describe("collectStaffCreateFieldErrors (FormField 用の項目別検証)", () => {
  it("正常: エラー無しは空オブジェクト", () => {
    expect(
      collectStaffCreateFieldErrors({ email: "teacher@example.com", displayName: "山田先生" }),
    ).toEqual({});
  });

  it("メール形式不正 / 長さ超過は email エラー", () => {
    expect(collectStaffCreateFieldErrors({ email: "bad", displayName: "X" }).email).toMatch(/形式/);
    // 形式は正しいが 320 文字超過も同じ email エラー (server と同じ統合判定)。
    expect(
      collectStaffCreateFieldErrors({ email: `${"a".repeat(320)}@b.co`, displayName: "X" }).email,
    ).toMatch(/形式/);
  });

  it("表示名 空 / 100 文字超は displayName エラー", () => {
    expect(
      collectStaffCreateFieldErrors({ email: "teacher@example.com", displayName: "   " })
        .displayName,
    ).toMatch(/表示名/);
    expect(
      collectStaffCreateFieldErrors({ email: "teacher@example.com", displayName: "あ".repeat(101) })
        .displayName,
    ).toMatch(/表示名/);
  });

  it("両方不正なら両キーが立つ", () => {
    expect(
      Object.keys(collectStaffCreateFieldErrors({ email: "", displayName: "" })).sort(),
    ).toEqual(["displayName", "email"]);
  });

  it("hasStaffCreateFieldErrors はエラー有無を判定する", () => {
    expect(hasStaffCreateFieldErrors({})).toBe(false);
    expect(hasStaffCreateFieldErrors({ email: "x" })).toBe(true);
  });
});

describe("validateStaffCreate (server 用: 最初のエラー + トリム)", () => {
  it("正常: トリム済みの値を返す", () => {
    expect(
      validateStaffCreate({ email: "  teacher@example.com  ", displayName: "  山田先生  " }),
    ).toEqual({ ok: true, value: { email: "teacher@example.com", displayName: "山田先生" } });
  });

  it("email を優先して 1 メッセージで返す", () => {
    const r = validateStaffCreate({ email: "bad", displayName: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/メールアドレス/);
    }
  });

  it("email OK・表示名 NG は displayName メッセージ", () => {
    const r = validateStaffCreate({ email: "teacher@example.com", displayName: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/表示名/);
    }
  });
});
