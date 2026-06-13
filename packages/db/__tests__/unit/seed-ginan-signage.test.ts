import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNAGE_BASE_URL,
  DEFAULT_SIGNAGE_TTL_DAYS,
  GINAN_SIGNAGE_GRADES,
  buildSignageUrl,
  generateToken,
  hashToken,
  isV2SignageUrl,
  resolveSignageBaseUrl,
  resolveSignageTtlDays,
} from "../../src/seed-ginan-signage.js";

/**
 * F15 / F05 (ADR-022 / ADR-019): 岐南 サイネージ magic link シードの純ロジック単体検証（DB 不要）。
 * トークン方式（apps/web と同形）・URL 組立・env 解決・冪等判定を固定する。秘匿規律: トークンは生成のみ検証し中身は assert しない。
 */

describe("generateToken / hashToken", () => {
  it("トークンは base64url（URL/QR セーフ文字のみ・十分な長さ）", () => {
    const t = generateToken();
    // 32 byte → base64url は約 43 文字、padding 無し、[A-Za-z0-9_-] のみ。
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it("トークンは毎回ユニーク（乱数）", () => {
    const set = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(set.size).toBe(50);
  });

  it("hashToken は SHA-256 hex（64 文字）で決定的", () => {
    const h1 = hashToken("sample-token-abc");
    const h2 = hashToken("sample-token-abc");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("different")).not.toBe(h1);
  });
});

describe("buildSignageUrl", () => {
  it("`<base>/signage/<token>` を組み立てる", () => {
    expect(buildSignageUrl("https://app.school-signage.net", "TOK")).toBe(
      "https://app.school-signage.net/signage/TOK",
    );
  });

  it("base 末尾スラッシュを正規化する（二重スラッシュ防止）", () => {
    expect(buildSignageUrl("https://app.school-signage.net/", "TOK")).toBe(
      "https://app.school-signage.net/signage/TOK",
    );
    expect(buildSignageUrl("https://app.school-signage.net///", "TOK")).toBe(
      "https://app.school-signage.net/signage/TOK",
    );
  });
});

describe("resolveSignageBaseUrl", () => {
  it("未指定/空なら既定 app.school-signage.net（県教委 Wi-Fi 許可 FQDN）", () => {
    expect(resolveSignageBaseUrl(undefined)).toBe(DEFAULT_SIGNAGE_BASE_URL);
    expect(resolveSignageBaseUrl("")).toBe(DEFAULT_SIGNAGE_BASE_URL);
    expect(resolveSignageBaseUrl("   ")).toBe(DEFAULT_SIGNAGE_BASE_URL);
  });

  it("指定された http(s) URL を末尾スラッシュ正規化して返す", () => {
    expect(resolveSignageBaseUrl("https://kimiterrace-web-xxx.a.run.app/")).toBe(
      "https://kimiterrace-web-xxx.a.run.app",
    );
    expect(resolveSignageBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("URL でない / 非 http(s) スキームは fail-fast", () => {
    expect(() => resolveSignageBaseUrl("not a url")).toThrow(/SIGNAGE_BASE_URL/);
    expect(() => resolveSignageBaseUrl("ftp://example.com")).toThrow(/http\(s\)/);
    expect(() => resolveSignageBaseUrl("javascript:alert(1)")).toThrow(/http\(s\)/);
  });
});

describe("resolveSignageTtlDays", () => {
  it("未指定なら既定 365 日（1 年＝学年度カバー・10 年から是正 finding④）", () => {
    expect(resolveSignageTtlDays(undefined)).toBe(DEFAULT_SIGNAGE_TTL_DAYS);
    expect(resolveSignageTtlDays("")).toBe(DEFAULT_SIGNAGE_TTL_DAYS);
    expect(DEFAULT_SIGNAGE_TTL_DAYS).toBe(365);
  });

  it("正の整数を受け付ける", () => {
    expect(resolveSignageTtlDays("90")).toBe(90);
    expect(resolveSignageTtlDays("1")).toBe(1);
  });

  it("非正・非整数は fail-fast", () => {
    expect(() => resolveSignageTtlDays("0")).toThrow(/positive integer/);
    expect(() => resolveSignageTtlDays("-5")).toThrow(/positive integer/);
    expect(() => resolveSignageTtlDays("1.5")).toThrow(/positive integer/);
    expect(() => resolveSignageTtlDays("abc")).toThrow(/positive integer/);
  });
});

describe("isV2SignageUrl（冪等判定）", () => {
  const base = "https://app.school-signage.net";

  it("同 base 配下 /signage/ のみ true", () => {
    expect(isV2SignageUrl(`${base}/signage/abc`, base)).toBe(true);
    expect(isV2SignageUrl(`${base}/signage/`, base)).toBe(true);
  });

  it("null / 空 / v1 クエリ形 / 別ホストは false（= 要差替）", () => {
    expect(isV2SignageUrl(null, base)).toBe(false);
    expect(isV2SignageUrl(undefined, base)).toBe(false);
    expect(isV2SignageUrl("", base)).toBe(false);
    // v1 形（Firebase ルート + クエリ）は差替対象。
    expect(isV2SignageUrl(`${base}/?school=x&class=y&kiosk=1`, base)).toBe(false);
    // 別ホスト（.run.app 等）は許可 FQDN でない＝差替対象。
    expect(isV2SignageUrl("https://kimiterrace-web-xxx.a.run.app/signage/abc", base)).toBe(false);
  });

  it("base の末尾スラッシュ差異を吸収する", () => {
    expect(isV2SignageUrl(`${base}/signage/abc`, `${base}/`)).toBe(true);
  });
});

describe("GINAN_SIGNAGE_GRADES", () => {
  it("電子工学科 1〜3 年ちょうど", () => {
    expect([...GINAN_SIGNAGE_GRADES]).toEqual([1, 2, 3]);
  });
});
