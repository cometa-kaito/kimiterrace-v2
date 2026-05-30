import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "../../lib/magic-link/token";

/** F05: トークン生成/ハッシュの unit テスト (pure、node:crypto、mock 不要)。 */
describe("magic-link token", () => {
  it("generateToken: base64url 文字種で十分な長さ・毎回異なる", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 byte の base64url は 43 文字 (パディングなし)
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).not.toBe(b);
  });

  it("hashToken: 決定的・SHA-256 hex 64 文字・平文と異なる", () => {
    const token = "fixed-token-value";
    const h1 = hashToken(token);
    const h2 = hashToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(token);
  });

  it("hashToken: 既知ベクトル (SHA-256 of 'abc')", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashToken: token が違えば hash も違う", () => {
    expect(hashToken("token-1")).not.toBe(hashToken("token-2"));
  });
});
