import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_AD_MODE,
  applyMonitorAdModeToUrl,
  getMonitorAdModeFromUrl,
  isMonitorAdExempt,
  isMonitorAdMode,
  stripMonitorAdModeParam,
} from "@/lib/signage/monitor-ad-mode";

/**
 * モニタ単位「授業中の広告可否」（`signage_url` の `?classAds=on`）の URL ヘルパ単体テスト。`?design` と同一
 * 機構（design-pattern.ts）を踏襲し、既定 `follow` はパラメータ無し・`always` は `?classAds=on`。design 等の
 * 併存パラメータを壊さないこと、未知値・パース不能は既定へ倒すこと（fail-soft）を固定する。
 */

const BASE = "https://app.school-signage.net/signage/tok123";

describe("isMonitorAdExempt（サイネージ経路の searchParam 判定）", () => {
  it("'on' のときだけ免除（授業中も広告）", () => {
    expect(isMonitorAdExempt("on")).toBe(true);
    expect(isMonitorAdExempt(null)).toBe(false);
    expect(isMonitorAdExempt(undefined)).toBe(false);
    expect(isMonitorAdExempt("true")).toBe(false);
    expect(isMonitorAdExempt("off")).toBe(false);
    expect(isMonitorAdExempt("")).toBe(false);
  });
});

describe("isMonitorAdMode", () => {
  it("follow / always だけ true", () => {
    expect(isMonitorAdMode("follow")).toBe(true);
    expect(isMonitorAdMode("always")).toBe(true);
    expect(isMonitorAdMode("x")).toBe(false);
    expect(isMonitorAdMode(undefined)).toBe(false);
  });
});

describe("getMonitorAdModeFromUrl", () => {
  it("classAds=on は always、それ以外・未指定は follow", () => {
    expect(getMonitorAdModeFromUrl(`${BASE}?classAds=on`)).toBe("always");
    expect(getMonitorAdModeFromUrl(BASE)).toBe("follow");
    expect(getMonitorAdModeFromUrl(`${BASE}?classAds=yes`)).toBe("follow");
    expect(getMonitorAdModeFromUrl(`${BASE}?design=pattern2`)).toBe("follow");
  });
  it("パース不能・空は既定 follow", () => {
    expect(getMonitorAdModeFromUrl("not a url")).toBe(DEFAULT_MONITOR_AD_MODE);
    expect(getMonitorAdModeFromUrl("")).toBe("follow");
    expect(getMonitorAdModeFromUrl(null)).toBe("follow");
  });
});

describe("applyMonitorAdModeToUrl", () => {
  it("always は ?classAds=on を付ける", () => {
    expect(applyMonitorAdModeToUrl(BASE, "always")).toBe(`${BASE}?classAds=on`);
  });
  it("follow はパラメータを付けない（元から無ければ原文維持）", () => {
    expect(applyMonitorAdModeToUrl(BASE, "follow")).toBe(BASE);
  });
  it("follow は既存の classAds を除去する", () => {
    expect(applyMonitorAdModeToUrl(`${BASE}?classAds=on`, "follow")).toBe(BASE);
  });
  it("design など併存パラメータを壊さない", () => {
    const withDesign = `${BASE}?design=pattern2`;
    expect(applyMonitorAdModeToUrl(withDesign, "always")).toBe(
      `${BASE}?design=pattern2&classAds=on`,
    );
    // design + classAds 併存から always→follow で classAds だけ消える。
    expect(applyMonitorAdModeToUrl(`${BASE}?design=pattern2&classAds=on`, "follow")).toBe(
      `${BASE}?design=pattern2`,
    );
  });
  it("パース不能はそのまま返す（fail-soft）", () => {
    expect(applyMonitorAdModeToUrl("relative/path", "always")).toBe("relative/path");
  });
});

describe("stripMonitorAdModeParam", () => {
  it("classAds を除去し、他は残す", () => {
    expect(stripMonitorAdModeParam(`${BASE}?classAds=on`)).toBe(BASE);
    expect(stripMonitorAdModeParam(`${BASE}?design=pattern2&classAds=on`)).toBe(
      `${BASE}?design=pattern2`,
    );
  });
  it("classAds が無ければ原文維持（正規化しない）", () => {
    expect(stripMonitorAdModeParam(BASE)).toBe(BASE);
    expect(stripMonitorAdModeParam(`${BASE}?design=pattern2`)).toBe(`${BASE}?design=pattern2`);
  });
  it("空・パース不能は安全に扱う", () => {
    expect(stripMonitorAdModeParam("")).toBe("");
    expect(stripMonitorAdModeParam("relative")).toBe("relative");
  });
});
