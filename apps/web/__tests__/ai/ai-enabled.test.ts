import { afterEach, describe, expect, it, vi } from "vitest";
import { AiDisabledError, assertAiEnabled, isAiEnabled } from "../../lib/ai/ai-enabled";

/**
 * #289: AI kill-switch (ai-enabled.ts) の単体テスト。
 *
 * `AI_ENABLED === "true"` の時だけ有効 (既定 OFF = fail-safe)。vitest.setup.ts がスイート既定で "true" を
 * 立てるため、無効ケースは `vi.stubEnv` で明示的に倒し、afterEach で復元する。
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAiEnabled", () => {
  it('AI_ENABLED === "true" の時だけ true', () => {
    vi.stubEnv("AI_ENABLED", "true");
    expect(isAiEnabled()).toBe(true);
  });

  // 厳密に小文字 "true" のみ有効 (fail-safe)。紛らわしい truthy 値はすべて無効に倒す。
  it.each([
    "false",
    "",
    "1",
    "TRUE",
    "True",
    "yes",
    "on",
  ])("AI_ENABLED=%j は false (厳密一致のみ有効)", (value) => {
    vi.stubEnv("AI_ENABLED", value);
    expect(isAiEnabled()).toBe(false);
  });

  it("AI_ENABLED 未設定は false (既定 OFF)", () => {
    vi.stubEnv("AI_ENABLED", undefined);
    expect(isAiEnabled()).toBe(false);
  });
});

describe("assertAiEnabled / AiDisabledError", () => {
  it("有効時は throw しない", () => {
    vi.stubEnv("AI_ENABLED", "true");
    expect(() => assertAiEnabled()).not.toThrow();
  });

  it("無効時は AiDisabledError を投げる", () => {
    vi.stubEnv("AI_ENABLED", "false");
    expect(() => assertAiEnabled()).toThrow(AiDisabledError);
  });

  it("AiDisabledError は Error のサブクラスで name='AiDisabledError'", () => {
    const err = new AiDisabledError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AiDisabledError");
  });
});
