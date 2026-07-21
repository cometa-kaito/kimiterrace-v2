import { describe, expect, it } from "vitest";
import { GINAN_ADS } from "../../src/seed-ginan-ads.js";
import {
  GINAN_AD_DURATION_SEC,
  GINAN_SCHOOL_NAME,
  USJC_AD,
  ginanAdMediaUrl,
  validateUsjcAd,
} from "../../src/seed-ginan-add-usjc.js";

/**
 * 岐南工業 電子工学科 PoC への **USJC 1 社 surgical 追加**シードの単体検証（I/O 非依存・DB 不要）。
 * 既存 6 社（GINAN_ADS）と id / display_order が衝突しないこと、値が確定していることを固定する。
 */

describe("USJC_AD", () => {
  it("社名・リンク・メディア・表示順が確定値", () => {
    expect(USJC_AD.companyName).toBe("USJC");
    expect(USJC_AD.linkUrl).toBe("https://www.usjpc.com/");
    expect(USJC_AD.mediaFile).toBe("usjc.png");
    expect(USJC_AD.displayOrder).toBe(70);
  });

  it("固定 UUID は 0007（既存 0001〜0006 の続き）", () => {
    expect(USJC_AD.advertiserId).toBe("91a00007-0000-4000-8000-000000000007");
    expect(USJC_AD.adId).toBe("91d00007-0000-4000-8000-000000000007");
  });

  it("既存 6 社と id / display_order が衝突しない（surgical add の非破壊前提）", () => {
    const advIds = new Set(GINAN_ADS.map((a) => a.advertiserId));
    const adIds = new Set(GINAN_ADS.map((a) => a.adId));
    const orders = new Set(GINAN_ADS.map((a) => a.displayOrder));
    expect(advIds.has(USJC_AD.advertiserId)).toBe(false);
    expect(adIds.has(USJC_AD.adId)).toBe(false);
    expect(orders.has(USJC_AD.displayOrder)).toBe(false);
  });

  it("display_order は既存の最大（60）より後ろ（末尾ローテーション）", () => {
    const maxExisting = Math.max(...GINAN_ADS.map((a) => a.displayOrder));
    expect(USJC_AD.displayOrder).toBeGreaterThan(maxExisting);
  });

  it("company_name は 1〜200 文字（advertisers.company_name 制約）", () => {
    expect(USJC_AD.companyName.length).toBeGreaterThan(0);
    expect(USJC_AD.companyName.length).toBeLessThanOrEqual(200);
  });

  it("media_url は既存 6 社と同一の公開バケット基底で https 絶対 URL", () => {
    const url = ginanAdMediaUrl(USJC_AD.mediaFile);
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("https:");
    expect(url.endsWith("/usjc.png")).toBe(true);
    // 既存 6 社（例: api.png）と同じ基底であること（端末が同じバケットから GET する）。
    expect(url.slice(0, url.lastIndexOf("/"))).toBe(
      ginanAdMediaUrl("api.png").slice(0, ginanAdMediaUrl("api.png").lastIndexOf("/")),
    );
  });
});

describe("validateUsjcAd", () => {
  it("USJC データは妥当（throw しない）", () => {
    expect(() => validateUsjcAd()).not.toThrow();
  });
});

describe("再エクスポート定数", () => {
  it("学校名・表示秒数は既存 seed と同一値を再エクスポート", () => {
    expect(GINAN_SCHOOL_NAME).toBe("岐阜県立岐南工業高等学校");
    expect(GINAN_AD_DURATION_SEC).toBe(7);
  });
});
