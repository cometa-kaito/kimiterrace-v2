import { describe, expect, it } from "vitest";
import {
  ADVERTISER_DELIVERY_LABEL,
  ADVERTISER_DELIVERY_ORDER,
  ADVERTISER_STATUS_LABEL,
  ADVERTISER_STATUS_ORDER,
  collectAdvertiserFieldErrors,
  companyNameError,
  hasAdvertiserFieldErrors,
  isActiveForStatus,
  isAdvertiserStatus,
  toDeliveryStatus,
  validateAdvertiserCreate,
  validateAdvertiserEdit,
} from "../../lib/system-admin/advertisers-core";

/**
 * F10 (#46): validateAdvertiserCreate の純検証テスト。会社名必須・任意項目の null 正規化・メール形式・
 * 最大長・前後空白トリム・ステータス (見込/契約中/休止) の membership を確認する。
 */
describe("validateAdvertiserCreate", () => {
  it("会社名のみで成立し、任意項目は null に正規化され status は既定 prospect", () => {
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
        status: "prospect",
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
      status: "active",
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
        status: "active",
      });
    }
  });

  it("status は 3 値のみ受理し、未指定/空は prospect・不正値は invalid", () => {
    expect(validateAdvertiserCreate({ companyName: "X", status: "active" })).toMatchObject({
      ok: true,
      value: { status: "active" },
    });
    expect(validateAdvertiserCreate({ companyName: "X", status: "paused" })).toMatchObject({
      ok: true,
      value: { status: "paused" },
    });
    // 空文字 / 未指定は既定 prospect
    expect(validateAdvertiserCreate({ companyName: "X", status: "" })).toMatchObject({
      ok: true,
      value: { status: "prospect" },
    });
    // 不正値は弾く (enum に無い値・型不一致)
    expect(validateAdvertiserCreate({ companyName: "X", status: "terminated" }).ok).toBe(false);
    expect(validateAdvertiserCreate({ companyName: "X", status: "ACTIVE" }).ok).toBe(false);
    expect(validateAdvertiserCreate({ companyName: "X", status: 1 }).ok).toBe(false);
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

describe("advertiser status helpers", () => {
  it("isAdvertiserStatus は 3 値のみ true (prototype キーは false)", () => {
    for (const s of ["prospect", "active", "paused"] as const) {
      expect(isAdvertiserStatus(s)).toBe(true);
    }
    expect(isAdvertiserStatus("terminated")).toBe(false);
    expect(isAdvertiserStatus("toString")).toBe(false); // prototype チェーン誤判定の回避
    expect(isAdvertiserStatus(undefined)).toBe(false);
    expect(isAdvertiserStatus(2)).toBe(false);
  });

  it("isActiveForStatus: paused のみ false (不変条件 status↔is_active)", () => {
    expect(isActiveForStatus("prospect")).toBe(true);
    expect(isActiveForStatus("active")).toBe(true);
    expect(isActiveForStatus("paused")).toBe(false);
  });

  it("ラベル・並び順は enum 全 3 値を網羅する", () => {
    expect(Object.keys(ADVERTISER_STATUS_LABEL).sort()).toEqual(
      ["active", "paused", "prospect"].sort(),
    );
    expect([...ADVERTISER_STATUS_ORDER]).toEqual(["prospect", "active", "paused"]);
  });
});

describe("広告主編集 (最小縮退) のヘルパ", () => {
  it("ADVERTISER_DELIVERY_ORDER / LABEL は配信 2 値 (active=稼働中 / paused=休止)", () => {
    expect([...ADVERTISER_DELIVERY_ORDER]).toEqual(["active", "paused"]);
    expect(ADVERTISER_DELIVERY_LABEL).toEqual({ active: "稼働中", paused: "休止" });
  });

  it("toDeliveryStatus: paused は休止、それ以外 (prospect / active) は稼働中扱い", () => {
    expect(toDeliveryStatus("paused")).toBe("paused");
    expect(toDeliveryStatus("active")).toBe("active");
    expect(toDeliveryStatus("prospect")).toBe("active");
  });

  it("companyNameError: 空/空白/超過はメッセージ、1..200 は undefined", () => {
    expect(companyNameError("")).toMatch(/会社名/);
    expect(companyNameError("   ")).toMatch(/会社名/);
    expect(companyNameError("あ".repeat(201))).toMatch(/会社名/);
    expect(companyNameError("アクメ商事")).toBeUndefined();
    expect(companyNameError("あ".repeat(200))).toBeUndefined();
  });

  it("validateAdvertiserEdit: 会社名必須 + 配信ステータスは active/paused のみ", () => {
    expect(validateAdvertiserEdit({ companyName: " アクメ ", status: "active" })).toEqual({
      ok: true,
      value: { companyName: "アクメ", status: "active" },
    });
    expect(validateAdvertiserEdit({ companyName: "X", status: "paused" })).toMatchObject({
      ok: true,
      value: { status: "paused" },
    });
    // 会社名空は invalid。
    expect(validateAdvertiserEdit({ companyName: "  ", status: "active" }).ok).toBe(false);
    // prospect・enum 外・型不一致・未指定は invalid (縮退編集は 2 値のみ)。
    expect(validateAdvertiserEdit({ companyName: "X", status: "prospect" }).ok).toBe(false);
    expect(validateAdvertiserEdit({ companyName: "X", status: "bogus" }).ok).toBe(false);
    expect(validateAdvertiserEdit({ companyName: "X", status: undefined }).ok).toBe(false);
    expect(validateAdvertiserEdit({ companyName: "X", status: 1 }).ok).toBe(false);
  });
});

describe("collectAdvertiserFieldErrors (FormField 用の項目別検証)", () => {
  it("会社名のみで成立: エラー無しは空オブジェクト (任意項目の空はエラーにしない)", () => {
    expect(collectAdvertiserFieldErrors({ companyName: "アクメ商事" })).toEqual({});
    expect(
      collectAdvertiserFieldErrors({ companyName: "X", industry: "", contactEmail: "" }),
    ).toEqual({});
  });

  it("会社名が空なら companyName エラー", () => {
    expect(collectAdvertiserFieldErrors({ companyName: "   " }).companyName).toMatch(/会社名/);
  });

  it("メールは形式違反と長さ超過を区別してエラーにする", () => {
    expect(
      collectAdvertiserFieldErrors({ companyName: "X", contactEmail: "not-an-email" }).contactEmail,
    ).toMatch(/形式/);
    expect(
      collectAdvertiserFieldErrors({ companyName: "X", contactEmail: `${"a".repeat(320)}@b.co` })
        .contactEmail,
    ).toMatch(/320 文字以内/);
    // 正しい形式はエラー無し。
    expect(
      collectAdvertiserFieldErrors({ companyName: "X", contactEmail: "a@b.co" }).contactEmail,
    ).toBeUndefined();
  });

  it("任意項目の最大長超過はそれぞれエラーになる", () => {
    const errors = collectAdvertiserFieldErrors({
      companyName: "X",
      industry: "い".repeat(101),
      contactPhone: "9".repeat(51),
      address: "あ".repeat(1001),
      notes: "ん".repeat(2001),
    });
    expect(errors.industry).toBeTruthy();
    expect(errors.contactPhone).toBeTruthy();
    expect(errors.address).toBeTruthy();
    expect(errors.notes).toBeTruthy();
  });

  it("hasAdvertiserFieldErrors はエラー有無を判定する", () => {
    expect(hasAdvertiserFieldErrors({})).toBe(false);
    expect(hasAdvertiserFieldErrors({ companyName: "x" })).toBe(true);
  });
});
