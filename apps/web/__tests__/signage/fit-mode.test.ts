import { describe, expect, it } from "vitest";
import { isEmbeddedSignageDevice, shouldApplyFitStage } from "@/lib/signage/fit-mode";

/**
 * `/signage/{classToken}` の fit-stage（タブレット/PC 縮小表示）出し分けの判定ロジック。
 * 実機端末（埋め込み WebView / TV）は全画面・人間の実ブラウザは縮小、という境界を pin する。
 */

const UA = {
  androidWebView:
    "Mozilla/5.0 (Linux; Android 11; KFONWI Build/RS8333; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/106.0.5249.126 Safari/537.36",
  googleTvCast:
    "Mozilla/5.0 (Linux; Android 12; Chromecast) AppleWebKit/537.36 (KHTML, like Gecko) CrKey/1.56.500000 Safari/537.36",
  braviaTv:
    "Mozilla/5.0 (Linux; Android 10; BRAVIA 4K GB) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0 Safari/537.36",
  desktopChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  androidTabletChrome:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
} as const;

describe("isEmbeddedSignageDevice", () => {
  it("Android WebView（`; wv)`）は端末扱い", () => {
    expect(isEmbeddedSignageDevice(UA.androidWebView)).toBe(true);
  });

  it("Google TV / 各社スマート TV ブラウザは端末扱い", () => {
    expect(isEmbeddedSignageDevice(UA.googleTvCast)).toBe(true);
    expect(isEmbeddedSignageDevice(UA.braviaTv)).toBe(true);
  });

  it("PC・タブレットの実ブラウザは端末扱いしない（人間＝縮小表示の対象）", () => {
    expect(isEmbeddedSignageDevice(UA.desktopChrome)).toBe(false);
    expect(isEmbeddedSignageDevice(UA.ipadSafari)).toBe(false);
    expect(isEmbeddedSignageDevice(UA.androidTabletChrome)).toBe(false);
  });

  it("空 UA は端末扱いしない（不明なら人間優先＝fit 側に倒す）", () => {
    expect(isEmbeddedSignageDevice("")).toBe(false);
  });
});

describe("shouldApplyFitStage", () => {
  it("?fit=on は UA を問わず必ず適用（端末でも強制縮小・検証用）", () => {
    expect(shouldApplyFitStage("on", UA.androidWebView)).toBe(true);
  });

  it("?fit=off は UA を問わず必ず非適用（端末の安全弁）", () => {
    expect(shouldApplyFitStage("off", UA.desktopChrome)).toBe(false);
  });

  it("未指定: 実ブラウザは適用 / 端末は非適用", () => {
    expect(shouldApplyFitStage(undefined, UA.desktopChrome)).toBe(true);
    expect(shouldApplyFitStage(undefined, UA.androidWebView)).toBe(false);
  });

  it("未指定 + UA なし（null）は適用（人間優先）", () => {
    expect(shouldApplyFitStage(undefined, null)).toBe(true);
  });

  it("配列クエリは先頭要素で判定し、未知値は UA フォールバック", () => {
    expect(shouldApplyFitStage(["off"], UA.desktopChrome)).toBe(false);
    // 未知値 "1" は on/off いずれでもないので UA 判定（端末→非適用）に倒れる。
    expect(shouldApplyFitStage("1", UA.androidWebView)).toBe(false);
    expect(shouldApplyFitStage("1", UA.desktopChrome)).toBe(true);
  });
});
