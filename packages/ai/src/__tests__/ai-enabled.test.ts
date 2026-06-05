import { afterEach, describe, expect, it } from "vitest";
import { AiDisabledError, assertAiEnabled, isAiEnabled } from "../ai-enabled.js";

/**
 * #593: 実 Vertex の kill-switch プリミティブ（ルール4 / ADR-030）。`AI_ENABLED === "true"` の時だけ
 * 有効で、未設定 / 空 / "false" / その他はすべて無効（fail-safe = 既定 OFF）であることを pin する。
 * apps/web・apps/jobs の両 Vertex 入口がこの単一ソースを参照するため、判定の厳密さを直接 unit で固定する。
 */
describe("isAiEnabled / assertAiEnabled (#593 AI kill-switch)", () => {
  const original = process.env.AI_ENABLED;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.AI_ENABLED;
    } else {
      process.env.AI_ENABLED = original;
    }
  });

  it('AI_ENABLED === "true" の時だけ有効', () => {
    process.env.AI_ENABLED = "true";
    expect(isAiEnabled()).toBe(true);
    expect(() => assertAiEnabled()).not.toThrow();
  });

  it("未設定 / 空 / false / 大文字 TRUE / その他はすべて無効（fail-safe、厳密一致）", () => {
    for (const value of [undefined, "", "false", "0", "TRUE", "True", "yes", "1", " true "]) {
      if (value === undefined) {
        delete process.env.AI_ENABLED;
      } else {
        process.env.AI_ENABLED = value;
      }
      expect(isAiEnabled(), `value=${JSON.stringify(value)}`).toBe(false);
      expect(() => assertAiEnabled(), `value=${JSON.stringify(value)}`).toThrow(AiDisabledError);
    }
  });
});
