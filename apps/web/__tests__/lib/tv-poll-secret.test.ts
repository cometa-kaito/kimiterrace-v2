import { afterEach, describe, expect, it } from "vitest";
import { getConfiguredTvPollSecret, verifyTvPollSecret } from "../../lib/tv/poll-secret";

/**
 * F15 (ADR-022): TV ポーリング共有シークレット検証の単体テスト（定数時間比較 + fail-closed）。
 */
describe("F15 TV poll secret 検証", () => {
  const prev = process.env.TV_POLL_SECRET;
  afterEach(() => {
    if (prev === undefined) delete process.env.TV_POLL_SECRET;
    else process.env.TV_POLL_SECRET = prev;
  });

  it("一致で true", () => {
    expect(verifyTvPollSecret("tv-s3cret", "tv-s3cret")).toBe(true);
  });

  it("不一致で false", () => {
    expect(verifyTvPollSecret("wrong", "tv-s3cret")).toBe(false);
  });

  it("長さ違いでも例外を投げず false（SHA-256 固定長比較で定数時間化）", () => {
    expect(verifyTvPollSecret("short", "a-much-longer-tv-secret-value")).toBe(false);
  });

  it("null / undefined / 空文字の provided は false", () => {
    expect(verifyTvPollSecret(null, "s")).toBe(false);
    expect(verifyTvPollSecret(undefined, "s")).toBe(false);
    expect(verifyTvPollSecret("", "s")).toBe(false);
  });

  it("env 未設定で getConfiguredTvPollSecret は null（fail-closed）", () => {
    delete process.env.TV_POLL_SECRET;
    expect(getConfiguredTvPollSecret()).toBe(null);
  });

  it("env 設定で getConfiguredTvPollSecret は値", () => {
    process.env.TV_POLL_SECRET = "abc123";
    expect(getConfiguredTvPollSecret()).toBe("abc123");
  });
});
