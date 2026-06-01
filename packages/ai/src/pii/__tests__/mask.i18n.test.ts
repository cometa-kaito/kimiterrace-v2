import { describe, expect, it } from "vitest";
import { findUnmaskedPii, maskPII, unmaskPII } from "../mask.js";
import type { PiiEntry } from "../types.js";

/**
 * F06 (S4): PII マスキングの多言語 / CJK 全角入力対応を言語別に検証する (ADR-028 / ルール4)。
 *
 * 既存 mask.test.ts は日本語半角を網羅する。本ファイルは「主要外国語の質問文」「全角入力」で
 * 氏名 (名簿) / 国際電話 / メールが確実にマスクされ、逆変換でラウンドトリップすることを固定する。
 */
describe("maskPII — 多言語 (氏名は名簿リテラルで言語非依存)", () => {
  it("英語: 氏名 + 国際電話 (+1) + メールをすべてマスクしラウンドトリップする", () => {
    const entries: PiiEntry[] = [{ value: "John Smith", category: "STUDENT" }];
    const original = "Student John Smith called +1-202-555-0147, email john.doe@example.com";
    const { masked, dictionary } = maskPII(original, entries);

    expect(masked).not.toContain("John Smith");
    expect(masked).not.toContain("+1-202-555-0147");
    expect(masked).not.toContain("john.doe@example.com");
    expect(masked).toContain("{{STUDENT_001}}");
    expect(masked).toContain("{{PHONE_001}}");
    expect(masked).toContain("{{EMAIL_001}}");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });

  it("ポルトガル語: 氏名 + ブラジル国際電話 (+55) をマスクする", () => {
    const entries: PiiEntry[] = [{ value: "João Silva", category: "STUDENT" }];
    const original = "O aluno João Silva, telefone +55 11 91234-5678";
    const { masked, dictionary } = maskPII(original, entries);

    expect(masked).not.toContain("João Silva");
    expect(masked).not.toContain("+55 11 91234-5678");
    expect(masked).toContain("{{STUDENT_001}}");
    expect(masked).toContain("{{PHONE_001}}");
    expect(unmaskPII(masked, dictionary)).toBe(original);
    // 逆変換で電話の原表記 (区切り含む) が完全復元されること。
    expect(dictionary["{{PHONE_001}}"]).toBe("+55 11 91234-5678");
  });

  it("やさしい日本語: ひらがな別名 (alias) で氏名を集約マスクする", () => {
    const entries: PiiEntry[] = [
      { value: "田中太郎", category: "STUDENT", aliases: ["たなか たろう", "たなかたろう"] },
    ];
    const original = "たなか たろう さん の でんわ は です";
    const { masked, dictionary } = maskPII(original, entries);

    expect(masked).toBe("{{STUDENT_001}} さん の でんわ は です");
    // 別名でマスクしても逆変換は正規表記 (value) に戻す。
    expect(unmaskPII(masked, dictionary)).toBe("田中太郎 さん の でんわ は です");
  });
});

describe("maskPII — 全角 (CJK) 入力", () => {
  it("全角数字・全角ハイフンの国内電話を検出し、原表記でラウンドトリップする", () => {
    const original = "でんわは ０９０－１２３４－５６７８ です";
    const { masked, dictionary } = maskPII(original, []);

    expect(masked).toBe("でんわは {{PHONE_001}} です");
    expect(dictionary["{{PHONE_001}}"]).toBe("０９０－１２３４－５６７８");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });

  it("全角＠・全角ドット・全角英字のメールを検出する", () => {
    const original = "メール ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ まで";
    const { masked, dictionary } = maskPII(original, []);

    expect(masked).toBe("メール {{EMAIL_001}} まで");
    expect(dictionary["{{EMAIL_001}}"]).toBe("ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });

  it("全角プラスの国際電話 (＋８１) を検出する", () => {
    const original = "国際は ＋８１－９０－１２３４－５６７８ へ";
    const { masked, dictionary } = maskPII(original, []);

    expect(masked).toContain("{{PHONE_001}}");
    expect(masked).not.toContain("＋８１");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });
});

describe("maskPII — 過検出を避ける (PII でない数値)", () => {
  it("先頭 0 でも + でもない普通の数値は電話として誤検出しない", () => {
    const original = "教室は 3 番、定員 40 名、在庫 12345 個";
    const { masked } = maskPII(original, []);
    expect(masked).toBe(original);
  });
});

describe("findUnmaskedPii — 多言語 / 全角の fail-closed 検証", () => {
  it("マスク漏れの国際電話を検出する", () => {
    expect(findUnmaskedPii("call +1-202-555-0147", [])).toContain("+1-202-555-0147");
  });

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
