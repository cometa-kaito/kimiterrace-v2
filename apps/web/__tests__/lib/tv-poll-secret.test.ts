import { afterEach, describe, expect, it } from "vitest";
import {
  getConfiguredTvPollSecret,
  getLegacyTvPollSecret,
  verifyTvPollKey,
  verifyTvPollSecret,
} from "../../lib/tv/poll-secret";

/**
 * F15 (ADR-022): TV ポーリング共有シークレット検証の単体テスト（定数時間比較 + fail-closed
 * + ゼロダウンタイム鍵ローテーションの二重受理）。
 */
describe("F15 TV poll secret 検証", () => {
  const prev = process.env.TV_POLL_SECRET;
  const prevLegacy = process.env.TV_POLL_SECRET_LEGACY;
  afterEach(() => {
    if (prev === undefined) delete process.env.TV_POLL_SECRET;
    else process.env.TV_POLL_SECRET = prev;
    if (prevLegacy === undefined) delete process.env.TV_POLL_SECRET_LEGACY;
    else process.env.TV_POLL_SECRET_LEGACY = prevLegacy;
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

  it("TV_POLL_SECRET_LEGACY 未設定で getLegacyTvPollSecret は null", () => {
    delete process.env.TV_POLL_SECRET_LEGACY;
    expect(getLegacyTvPollSecret()).toBe(null);
  });

  it("TV_POLL_SECRET_LEGACY 設定で getLegacyTvPollSecret は値", () => {
    process.env.TV_POLL_SECRET_LEGACY = "old-key";
    expect(getLegacyTvPollSecret()).toBe("old-key");
  });

  describe("verifyTvPollKey（二重受理・ゼロダウンタイム鍵ローテ）", () => {
    it("現用キー（TV_POLL_SECRET）一致で true", () => {
      process.env.TV_POLL_SECRET = "new-key";
      delete process.env.TV_POLL_SECRET_LEGACY;
      expect(verifyTvPollKey("new-key")).toBe(true);
    });

    it("移行期は旧キー（TV_POLL_SECRET_LEGACY）も受理（無停止）", () => {
      process.env.TV_POLL_SECRET = "new-key";
      process.env.TV_POLL_SECRET_LEGACY = "old-key";
      expect(verifyTvPollKey("new-key")).toBe(true);
      expect(verifyTvPollKey("old-key")).toBe(true);
    });

    it("どちらにも一致しなければ false", () => {
      process.env.TV_POLL_SECRET = "new-key";
      process.env.TV_POLL_SECRET_LEGACY = "old-key";
      expect(verifyTvPollKey("nope")).toBe(false);
    });

    it("ローテ完了後（LEGACY 削除）は旧キーを拒否し新キーのみ受理", () => {
      process.env.TV_POLL_SECRET = "new-key";
      delete process.env.TV_POLL_SECRET_LEGACY;
      expect(verifyTvPollKey("new-key")).toBe(true);
      expect(verifyTvPollKey("old-key")).toBe(false);
    });

    it("受理キーが 1 つも未設定なら fail-closed で false", () => {
      delete process.env.TV_POLL_SECRET;
      delete process.env.TV_POLL_SECRET_LEGACY;
      expect(verifyTvPollKey("anything")).toBe(false);
    });

    it("null / undefined / 空文字の provided は false", () => {
      process.env.TV_POLL_SECRET = "new-key";
      expect(verifyTvPollKey(null)).toBe(false);
      expect(verifyTvPollKey(undefined)).toBe(false);
      expect(verifyTvPollKey("")).toBe(false);
    });
  });
});
