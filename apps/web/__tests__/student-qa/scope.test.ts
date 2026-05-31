import { describe, expect, it } from "vitest";
import {
  MAX_QUESTION_LENGTH,
  OUT_OF_SCOPE_REPLY,
  validateQuestion,
} from "../../lib/student-qa/scope";

/**
 * F06 (#42): 質問入力バリデーションと拒否文言の決定的検証。
 */

describe("validateQuestion", () => {
  it("通常の質問は trim して許可する", () => {
    expect(validateQuestion("  明日の体育祭は？  ")).toEqual({
      ok: true,
      question: "明日の体育祭は？",
    });
  });

  it("空文字・空白のみは empty で拒否する", () => {
    expect(validateQuestion("")).toEqual({ ok: false, reason: "empty" });
    expect(validateQuestion("   \n\t ")).toEqual({ ok: false, reason: "empty" });
  });

  it("上限ちょうどは許可、超過は too_long で拒否する（境界）", () => {
    const atLimit = "あ".repeat(MAX_QUESTION_LENGTH);
    const over = "あ".repeat(MAX_QUESTION_LENGTH + 1);
    expect(validateQuestion(atLimit)).toEqual({ ok: true, question: atLimit });
    expect(validateQuestion(over)).toEqual({ ok: false, reason: "too_long" });
  });

  it("trim 後の長さで上限判定する（前後空白は数えない）", () => {
    const padded = `  ${"あ".repeat(MAX_QUESTION_LENGTH)}  `;
    expect(validateQuestion(padded).ok).toBe(true);
  });
});

describe("OUT_OF_SCOPE_REPLY", () => {
  it("誘導なしの定型拒否文である", () => {
    expect(OUT_OF_SCOPE_REPLY).toBe("ごめんなさい、それは掲示物の話題から外れます。");
  });
});
