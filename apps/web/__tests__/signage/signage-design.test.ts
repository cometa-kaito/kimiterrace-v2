import {
  DEFAULT_SIGNAGE_DESIGN_PATTERN,
  isSignageDesignPattern,
  parseSignageDesignPattern,
} from "@/lib/signage/signage-design";
import { describe, expect, it } from "vitest";

/**
 * 学校別サイネージデザインパターンの解決ロジック（#48 / 学校別デザイン）。
 * `school_configs` の display_settings.value（opaque JSONB）から `signageDesign` を defensive に取り出し、
 * 未設定・不正・未知パターンは既定 `pattern1`（今回作成した v1 レイアウト）にフォールバックする。
 */
describe("parseSignageDesignPattern", () => {
  it("display_settings.signageDesign が既知パターンならそれを採用する", () => {
    expect(parseSignageDesignPattern({ signageDesign: "pattern1" })).toBe("pattern1");
  });

  it("未設定 (null / 空オブジェクト / キー欠落) は既定 pattern1", () => {
    expect(parseSignageDesignPattern(null)).toBe("pattern1");
    expect(parseSignageDesignPattern(undefined)).toBe("pattern1");
    expect(parseSignageDesignPattern({})).toBe("pattern1");
    expect(parseSignageDesignPattern({ other: "x" })).toBe("pattern1");
  });

  it("未知パターン・非文字列・非オブジェクトは既定にフォールバック (fail-soft、盤面を壊さない)", () => {
    expect(parseSignageDesignPattern({ signageDesign: "pattern999" })).toBe("pattern1");
    expect(parseSignageDesignPattern({ signageDesign: 123 })).toBe("pattern1");
    expect(parseSignageDesignPattern("pattern1")).toBe("pattern1"); // 文字列(非オブジェクト)も既定
    expect(parseSignageDesignPattern(["pattern1"])).toBe("pattern1"); // 配列も既定
  });

  it("既定値は pattern1（今回作成した v1 レイアウト）", () => {
    expect(DEFAULT_SIGNAGE_DESIGN_PATTERN).toBe("pattern1");
  });
});

describe("isSignageDesignPattern", () => {
  it("既知パターンのみ true、それ以外は false", () => {
    expect(isSignageDesignPattern("pattern1")).toBe(true);
    expect(isSignageDesignPattern("pattern2")).toBe(false);
    expect(isSignageDesignPattern("")).toBe(false);
    expect(isSignageDesignPattern(null)).toBe(false);
    expect(isSignageDesignPattern(123)).toBe(false);
    expect(isSignageDesignPattern({ signageDesign: "pattern1" })).toBe(false);
  });
});
