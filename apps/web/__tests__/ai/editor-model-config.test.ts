import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEditorModelConfig } from "../../lib/ai/editor-model-config";

/**
 * Editor AI の env 由来設定（model ID + thinking budget）解決の単体テスト。
 *
 * `GEMINI_MODEL` / `GEMINI_THINKING_BUDGET` を `vi.stubEnv` で立て、未設定/不正は undefined に倒して
 * クライアント既定へフォールバックする規則を固定する（#593 モデル ID env 化 / thinking-budget tuning）。
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveEditorModelConfig", () => {
  it("env 未設定なら modelId/tuning とも undefined（クライアント既定にフォールバック）", () => {
    vi.stubEnv("GEMINI_MODEL", undefined);
    vi.stubEnv("GEMINI_THINKING_BUDGET", undefined);
    expect(resolveEditorModelConfig()).toEqual({ modelId: undefined, tuning: undefined });
  });

  it("GEMINI_MODEL を modelId に通す（前後空白は除去）", () => {
    vi.stubEnv("GEMINI_MODEL", "  gemini-3.0-flash  ");
    vi.stubEnv("GEMINI_THINKING_BUDGET", undefined);
    expect(resolveEditorModelConfig().modelId).toBe("gemini-3.0-flash");
  });

  it("空文字の GEMINI_MODEL は undefined 扱い", () => {
    vi.stubEnv("GEMINI_MODEL", "   ");
    expect(resolveEditorModelConfig().modelId).toBeUndefined();
  });

  it("GEMINI_THINKING_BUDGET を tuning.thinkingBudget に通す（0 は有効＝思考無効化）", () => {
    vi.stubEnv("GEMINI_THINKING_BUDGET", "0");
    expect(resolveEditorModelConfig().tuning).toEqual({ thinkingBudget: 0 });

    vi.stubEnv("GEMINI_THINKING_BUDGET", "512");
    expect(resolveEditorModelConfig().tuning).toEqual({ thinkingBudget: 512 });
  });

  it.each([
    "",
    " ",
    "abc",
    "-1",
    "1.5",
    "NaN",
  ])("不正な GEMINI_THINKING_BUDGET=%j は tuning undefined にフォールバック", (value) => {
    vi.stubEnv("GEMINI_THINKING_BUDGET", value);
    expect(resolveEditorModelConfig().tuning).toBeUndefined();
  });
});
