import { describe, expect, it } from "vitest";
import { validateAdvertiserCreate } from "../../lib/system-admin/advertisers-core";

/**
 * F10 (#46): validateAdvertiserCreate の純検証テスト。会社名必須・任意項目の null 正規化・メール形式・
 * 最大長・前後空白トリムを確認する。
 */
describe("validateAdvertiserCreate", () => {
  it("会社名のみで成立し、任意項目は null に正規化される", () => {
    const v = validateAdvertiserCreate({ companyName: "アクメ商事" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value).toEqual({
        companyName: "アクメ商事",
        industry: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        notes: null,
      });
    }
  });

  it("全項目を受け取り、前後空白をトリムする", () => {
    const v = validateAdvertiserCreate({
      companyName: "  アクメ商事  ",
      industry: " 広告 ",
      contactEmail: " sales@acme.example ",
      contactPhone: " 03-1234-5678 ",
      address: " 東京都… ",
      notes: " 重要顧客 ",
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value).toEqual({
        companyName: "アクメ商事",
        industry: "広告",
        contactEmail: "sales@acme.example",
        contactPhone: "03-1234-5678",
        address: "東京都…",
        notes: "重要顧客",
      });
    }
  });

  it("会社名が空/空白のみは invalid", () => {
    expect(validateAdvertiserCreate({ companyName: "" }).ok).toBe(false);
    expect(validateAdvertiserCreate({ companyName: "   " }).ok).toBe(false);
    expect(validateAdvertiserCreate({}).ok).toBe(false);
  });

  it("会社名が 200 文字超は invalid", () => {
    expect(validateAdvertiserCreate({ companyName: "あ".repeat(201) }).ok).toBe(false);
    expect(validateAdvertiserCreate({ companyName: "あ".repeat(200) }).ok).toBe(true);
  });

  it("メール形式が不正なら invalid (任意だが入力時は形式を確認)", () => {
    expect(validateAdvertiserCreate({ companyName: "X", contactEmail: "not-an-email" }).ok).toBe(
      false,
    );
    expect(validateAdvertiserCreate({ companyName: "X", contactEmail: "a@b.co" }).ok).toBe(true);
  });

  it("任意項目の最大長超過は invalid", () => {
    expect(validateAdvertiserCreate({ companyName: "X", industry: "い".repeat(101) }).ok).toBe(
      false,
    );
    expect(validateAdvertiserCreate({ companyName: "X", contactPhone: "9".repeat(51) }).ok).toBe(
      false,
    );
    expect(validateAdvertiserCreate({ companyName: "X", notes: "ん".repeat(2001) }).ok).toBe(false);
  });
});
