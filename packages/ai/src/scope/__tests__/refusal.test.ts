import { describe, expect, it } from "vitest";
import type { ScopeClassification } from "../classify.js";
import { buildScopeRefusal, normalizeLocale } from "../refusal.js";

/** out_of_scope の分類結果を作るヘルパー。 */
function outOfScope(reason: "study" | "career", matched: string): ScopeClassification {
  return { verdict: "out_of_scope", reason, matched };
}

describe("buildScopeRefusal (ADR-028 §2 out_of_scope 拒否)", () => {
  it("日本語は ADR-028 §2 の確定句『それは掲示物の話題から外れます』を含む", () => {
    const msg = buildScopeRefusal(outOfScope("study", "宿題"), "ja");
    expect(msg).toContain("それは掲示物の話題から外れます");
  });

  it("各ロケールで非空の拒否文言を返す", () => {
    for (const locale of ["ja", "ja-easy", "en", "pt"] as const) {
      const msg = buildScopeRefusal(outOfScope("career", "進路"), locale);
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("拒否理由 (study / career) で文言は変わらない (ADR-028 §2 は単一文言)", () => {
    const study = buildScopeRefusal(outOfScope("study", "勉強を教えて"), "ja");
    const career = buildScopeRefusal(outOfScope("career", "受験勉強"), "ja");
    expect(study).toBe(career);
  });

  it("誘導なし拒否: 学習・進路の答え方を示唆する語を含めない", () => {
    // 拒否文に「答え」「解き方」「教えます」等の学習補助の誘導が混ざっていないこと。
    for (const locale of ["ja", "ja-easy", "en", "pt"] as const) {
      const msg = buildScopeRefusal(outOfScope("study", "宿題"), locale);
      expect(msg).not.toMatch(/解き方|答えは|教えます|手伝います|how to solve|the answer is/i);
    }
  });

  it("既定ロケールは ja", () => {
    const msg = buildScopeRefusal(outOfScope("study", "宿題"));
    expect(msg).toContain("掲示物の話題から外れます");
  });

  it("未対応ロケールは ja にフォールバックする", () => {
    // @ts-expect-error 未対応ロケールを意図的に渡し、フォールバックを検証する。
    const msg = buildScopeRefusal(outOfScope("study", "宿題"), "fr");
    expect(msg).toContain("掲示物の話題から外れます");
  });

  it("in_scope の分類に拒否文を作ろうとすると throw (呼び出し側のバグ検出)", () => {
    const inScope: ScopeClassification = { verdict: "in_scope", reason: null, matched: null };
    expect(() => buildScopeRefusal(inScope, "ja")).toThrow();
  });
});

describe("normalizeLocale", () => {
  it("素の言語タグを対応ロケールに正規化する", () => {
    expect(normalizeLocale("ja")).toBe("ja");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("pt")).toBe("pt");
  });

  it("地域サフィックス付きタグを主言語に畳む", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("pt-BR")).toBe("pt");
    expect(normalizeLocale("ja-JP")).toBe("ja");
    expect(normalizeLocale("EN-GB")).toBe("en");
  });

  it("やさしい日本語は明示タグでのみ選ぶ (素の ja は通常日本語)", () => {
    expect(normalizeLocale("ja-easy")).toBe("ja-easy");
    expect(normalizeLocale("ja-hira")).toBe("ja-easy");
    expect(normalizeLocale("ja")).toBe("ja");
  });

  it("未対応 / 空は ja にフォールバックする", () => {
    expect(normalizeLocale("fr")).toBe("ja");
    expect(normalizeLocale("")).toBe("ja");
    expect(normalizeLocale(null)).toBe("ja");
    expect(normalizeLocale(undefined)).toBe("ja");
  });
});
