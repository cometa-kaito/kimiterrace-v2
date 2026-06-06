import { describe, expect, it } from "vitest";
import {
  GINAN_AD_DURATION_SEC,
  GINAN_ADS,
  GINAN_SCHOOL_NAME,
  type GinanAdvertiserAd,
  ginanAdMediaUrl,
  validateGinanAds,
} from "../../src/seed-ginan-ads.js";

/**
 * 岐南工業 電子工学科 PoC の実契約 6 社サイネージ広告シードデータの単体検証（I/O 非依存・DB 不要）。
 * 6 社ちょうど・id 一意・URL が http(s)・解決キー（学校名）・media_url 合成・caption 方針を固定する。
 */

/** 妥当な広告レコードのひな型（負例テストが一部だけ壊して使う・index 型に依存しない）。 */
function sampleAd(over: Partial<GinanAdvertiserAd> = {}): GinanAdvertiserAd {
  return {
    advertiserId: "91a00099-0000-4000-8000-000000000099",
    adId: "91d00099-0000-4000-8000-000000000099",
    companyName: "サンプル株式会社",
    industry: "サンプル業",
    notes: "test",
    mediaFile: "sample.png",
    linkUrl: "https://example.com/",
    displayOrder: 99,
    ...over,
  };
}

describe("GINAN_ADS", () => {
  it("実契約 6 社ちょうど", () => {
    expect(GINAN_ADS).toHaveLength(6);
  });

  it("6 社の社名が確定値（順序＝display_order 昇順）", () => {
    expect(GINAN_ADS.map((a) => a.companyName)).toEqual([
      "京三エレコス株式会社",
      "株式会社シーテック",
      "日本クロージャー株式会社",
      "株式会社ギフ加藤製作所",
      "トーカイテック株式会社",
      "アピ株式会社",
    ]);
  });

  it("advertiserId / adId / displayOrder はそれぞれ一意", () => {
    expect(new Set(GINAN_ADS.map((a) => a.advertiserId)).size).toBe(6);
    expect(new Set(GINAN_ADS.map((a) => a.adId)).size).toBe(6);
    expect(new Set(GINAN_ADS.map((a) => a.displayOrder)).size).toBe(6);
  });

  it("display_order は昇順に並ぶ（ローテーション順の決定性）", () => {
    const orders = GINAN_ADS.map((a) => a.displayOrder);
    expect([...orders].sort((x, y) => x - y)).toEqual(orders);
  });

  it("link_url は各社公式 HP（https、求人ページでない会社案内トップ）", () => {
    const byCompany = new Map(GINAN_ADS.map((a) => [a.companyName, a.linkUrl]));
    expect(byCompany.get("京三エレコス株式会社")).toBe("https://www.kyosan-elcs.co.jp/");
    expect(byCompany.get("株式会社シーテック")).toBe("https://www.ctechcorp.co.jp/");
    expect(byCompany.get("日本クロージャー株式会社")).toBe("https://www.ncc-caps.co.jp/");
    expect(byCompany.get("株式会社ギフ加藤製作所")).toBe("https://www.kgk.jp/");
    expect(byCompany.get("トーカイテック株式会社")).toBe("https://www.tokai-tech.net/");
    expect(byCompany.get("アピ株式会社")).toBe("https://www.api3838.co.jp/");
  });

  it("各社の掲載画像ファイル名は一意で PNG/JPG", () => {
    const files = GINAN_ADS.map((a) => a.mediaFile);
    expect(new Set(files).size).toBe(6);
    for (const f of files) {
      expect(f).toMatch(/\.(png|jpg)$/);
    }
  });

  it("company_name は 1〜200 文字（advertisers.company_name 制約）", () => {
    for (const a of GINAN_ADS) {
      expect(a.companyName.length).toBeGreaterThan(0);
      expect(a.companyName.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("ginanAdMediaUrl", () => {
  it("公開バケット基底 + キーで http(s) の絶対 URL を合成する", () => {
    const url = ginanAdMediaUrl("kyosan-elcs.png");
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("https:");
    expect(url.endsWith("/kyosan-elcs.png")).toBe(true);
  });
});

describe("validateGinanAds", () => {
  it("既定のシードは妥当（throw しない）", () => {
    expect(() => validateGinanAds(GINAN_ADS)).not.toThrow();
  });

  it("adId が重複していれば throw", () => {
    const dup = [
      sampleAd({ adId: "dup", advertiserId: "a1", displayOrder: 1 }),
      sampleAd({ adId: "dup", advertiserId: "a2", displayOrder: 2 }),
    ];
    expect(() => validateGinanAds(dup)).toThrow();
  });

  it("link_url が http(s) でなければ throw", () => {
    expect(() => validateGinanAds([sampleAd({ linkUrl: "javascript:alert(1)" })])).toThrow();
  });

  it("displayOrder が重複していれば throw", () => {
    const dup = [
      sampleAd({ adId: "x1", advertiserId: "a1", displayOrder: 5 }),
      sampleAd({ adId: "x2", advertiserId: "a2", displayOrder: 5 }),
    ];
    expect(() => validateGinanAds(dup)).toThrow();
  });
});

describe("定数", () => {
  it("学校名は岐南工業の実レコード名（解決キー / staging schools.name と一致）", () => {
    // staging の schools.name は実レコード「岐阜県立岐南工業高等学校」（seed-ginan-sensors が
    // 665b6b7 でこの名に修正済）。旧名「…高校」だと WHERE name 一致せず fail-loud するため厳密に pin。
    expect(GINAN_SCHOOL_NAME).toBe("岐阜県立岐南工業高等学校");
  });

  it("表示秒数は正", () => {
    expect(GINAN_AD_DURATION_SEC).toBeGreaterThan(0);
  });
});
