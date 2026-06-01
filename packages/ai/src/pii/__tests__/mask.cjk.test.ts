import { describe, expect, it } from "vitest";
import { findUnmaskedPii, maskPII, unmaskPII } from "../mask.js";

/**
 * F06 (#383): PII マスキングの全角 (CJK) 入力対応を固定する (ADR-028 / ルール4)。
 *
 * 日本語 IME では電話・メールが全角で入力されがちで、半角前提だと全角の PII が Vertex へ素通りする。
 * 全角数字・全角＋/－/．/＠・全角英字 TLD を検出し、検出表層は原文のまま辞書化して逆変換で
 * ラウンドトリップすること、半角 ASCII の既存挙動が不変であること、過検出しないことを検証する。
 */
describe("maskPII — 全角 (CJK) 入力の電話・メール検出", () => {
  it("全角数字・全角ハイフンの国内電話を検出しラウンドトリップする", () => {
    const original = "でんわは ０９０－１２３４－５６７８ です";
    const { masked, dictionary } = maskPII(original, []);

    expect(masked).toBe("でんわは {{PHONE_001}} です");
    expect(dictionary["{{PHONE_001}}"]).toBe("０９０－１２３４－５６７８");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });

  it("全角プラスの国際電話 (＋８１) を検出する", () => {
    const original = "国際は ＋８１－９０－１２３４－５６７８ へ";
    const { masked, dictionary } = maskPII(original, []);

    expect(masked).toContain("{{PHONE_001}}");
    expect(masked).not.toContain("＋８１");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });

  it("全角＠・全角ドット・全角英字のメールを検出する", () => {
    const original = "メール ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ まで";
    const { masked, dictionary } = maskPII(original, []);

    expect(masked).toBe("メール {{EMAIL_001}} まで");
    expect(dictionary["{{EMAIL_001}}"]).toBe("ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });

  it("半角 ASCII の電話・メールは従来どおり検出する (上位集合化で挙動不変)", () => {
    const original = "代表 090-1234-5678 / 国際 +1-202-555-0147 / a@b.co";
    const { masked } = maskPII(original, []);

    expect(masked).not.toContain("090-1234-5678");
    expect(masked).not.toContain("+1-202-555-0147");
    expect(masked).not.toContain("a@b.co");
    expect(masked).toContain("{{PHONE_001}}");
    expect(masked).toContain("{{PHONE_002}}");
    expect(masked).toContain("{{EMAIL_001}}");
  });

  it("全角でも PII でない短い数値は電話として誤検出しない", () => {
    const original = "教室は ３ 番、定員 ４０ 名";
    const { masked } = maskPII(original, []);
    expect(masked).toBe(original);
  });
});

describe("findUnmaskedPii — 全角の fail-closed 検証", () => {
  it("マスク漏れの全角電話を検出する", () => {
    expect(findUnmaskedPii("でんわ ０９０－１２３４－５６７８", [])).toContain(
      "０９０－１２３４－５６７８",
    );
  });

  it("マスク漏れの全角メールを検出する", () => {
    expect(findUnmaskedPii("メール ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ", [])).toContain(
      "ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ",
    );
  });
});
