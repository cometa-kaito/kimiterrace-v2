import { describe, expect, it } from "vitest";
import { buildInAppResetLink, extractOobCode } from "../../lib/auth/reset-link";

/**
 * 自前リセットページへのリンク載せ替え (fix #1) の純ロジック検証。
 *
 * 核心の不変条件:
 * - Firebase 既定リンクから oobCode を取り出し `{origin}/reset-password?oobCode=...` に載せ替える。
 * - oobCode 抽出不能 / origin 空のときは **既定リンクをそのまま返す** (発行を壊さない = 安全側、非空虚)。
 */

const FB_LINK =
  "https://signage-v2-staging.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=ABC_123-xyz&apiKey=K&lang=en";

describe("extractOobCode", () => {
  it("Firebase reset リンクから oobCode を取り出す", () => {
    expect(extractOobCode(FB_LINK)).toBe("ABC_123-xyz");
  });

  it("oobCode が無い URL は null", () => {
    expect(extractOobCode("https://example.com/foo?mode=resetPassword")).toBeNull();
  });

  it("URL として解析不能な文字列は null (throw しない)", () => {
    expect(extractOobCode("not a url")).toBeNull();
    expect(extractOobCode("")).toBeNull();
  });
});

describe("buildInAppResetLink", () => {
  it("oobCode を自前ページに載せ替える", () => {
    expect(buildInAppResetLink(FB_LINK, "https://app.example")).toBe(
      "https://app.example/reset-password?oobCode=ABC_123-xyz",
    );
  });

  it("origin 末尾スラッシュを正規化して二重 // を避ける", () => {
    expect(buildInAppResetLink(FB_LINK, "https://app.example/")).toBe(
      "https://app.example/reset-password?oobCode=ABC_123-xyz",
    );
  });

  it("oobCode を URL エンコードする (クエリ破壊防止)", () => {
    const link = "https://x.firebaseapp.com/__/auth/action?oobCode=a%2Bb%2Fc";
    // URLSearchParams.get はデコード済みを返すので a+b/c → 再エンコードで a%2Bb%2Fc。
    expect(buildInAppResetLink(link, "https://app.example")).toBe(
      "https://app.example/reset-password?oobCode=a%2Bb%2Fc",
    );
  });

  it("oobCode 抽出不能なら既定リンクをそのまま返す (フォールバック、非空虚)", () => {
    const noCode = "https://example.com/__/auth/action?mode=resetPassword";
    expect(buildInAppResetLink(noCode, "https://app.example")).toBe(noCode);
  });

  it("origin が空なら既定リンクをそのまま返す (origin 解決失敗時のフォールバック)", () => {
    expect(buildInAppResetLink(FB_LINK, "")).toBe(FB_LINK);
  });
});
