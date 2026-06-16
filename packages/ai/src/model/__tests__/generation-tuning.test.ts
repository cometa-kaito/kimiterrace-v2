import { describe, expect, it } from "vitest";
import {
  DRAFT_TEMPERATURE,
  type GenerationTuning,
  mergeTuning,
  toGenerationOptions,
} from "../generation-tuning.js";

/**
 * Editor AI 生成パラメータチューニング（純データ写像）のテスト。`streamObject`/`streamText` へ重ねる
 * 追加オプションの形（temperature/maxOutputTokens トップレベル + thinkingBudget の providerOptions 写像）と、
 * 既定 × 上書きのフィールド単位マージ規則を固定する。実モデル挙動は対象外（配線は各 stream client のテスト）。
 */

describe("toGenerationOptions", () => {
  it("temperature / maxOutputTokens をトップレベルへ写す", () => {
    expect(toGenerationOptions({ temperature: 0.3, maxOutputTokens: 2048 })).toEqual({
      temperature: 0.3,
      maxOutputTokens: 2048,
    });
  });

  it("thinkingBudget を providerOptions.google.thinkingConfig へ写す（思考は応答に含めない）", () => {
    expect(toGenerationOptions({ thinkingBudget: 0 })).toEqual({
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
      },
    });
    expect(
      toGenerationOptions({ thinkingBudget: 512 }).providerOptions?.google.thinkingConfig,
    ).toEqual({ thinkingBudget: 512, includeThoughts: false });
  });

  it("未指定フィールドはキー自体を生やさない（SDK 既定を尊重）", () => {
    const out = toGenerationOptions({ temperature: 0.3 });
    expect(out).toEqual({ temperature: 0.3 });
    expect("maxOutputTokens" in out).toBe(false);
    expect("providerOptions" in out).toBe(false);
  });

  it("空 tuning は空オブジェクト（何も注入しない）", () => {
    expect(toGenerationOptions({})).toEqual({});
  });
});

describe("mergeTuning", () => {
  const defaults: GenerationTuning = { temperature: DRAFT_TEMPERATURE, maxOutputTokens: 2048 };

  it("override 未指定なら既定の複製を返す", () => {
    const merged = mergeTuning(defaults, undefined);
    expect(merged).toEqual({ temperature: DRAFT_TEMPERATURE, maxOutputTokens: 2048 });
    expect(merged).not.toBe(defaults);
  });

  it("override の指定フィールドだけ既定を上書きする", () => {
    expect(mergeTuning(defaults, { temperature: 0.1 })).toEqual({
      temperature: 0.1,
      maxOutputTokens: 2048,
    });
  });

  it("override の undefined フィールドは既定を潰さない", () => {
    expect(mergeTuning(defaults, { thinkingBudget: 256 })).toEqual({
      temperature: DRAFT_TEMPERATURE,
      maxOutputTokens: 2048,
      thinkingBudget: 256,
    });
  });

  it("thinkingBudget=0 は有効値として通す（思考無効化）", () => {
    expect(mergeTuning(defaults, { thinkingBudget: 0 }).thinkingBudget).toBe(0);
  });
});
