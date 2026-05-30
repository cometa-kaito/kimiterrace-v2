import { describe, expect, it } from "vitest";
import { findUnmaskedPii, maskPII, unmaskPII } from "../mask.js";
import type { PiiEntry } from "../types.js";

describe("maskPII — 名簿ベース", () => {
  it("CLAUDE.md ルール4 の例: 生徒氏名をトークン化する", () => {
    const entries: PiiEntry[] = [{ value: "田中太郎", category: "STUDENT" }];
    const { masked, dictionary } = maskPII("田中太郎さんは欠席", entries);
    expect(masked).toBe("{{STUDENT_001}}さんは欠席");
    expect(dictionary).toEqual({ "{{STUDENT_001}}": "田中太郎" });
  });

  it("長い表層形を先に置換し、部分一致の取りこぼしを防ぐ", () => {
    const entries: PiiEntry[] = [
      { value: "田中", category: "STUDENT" },
      { value: "田中太郎", category: "STUDENT" },
    ];
    const { masked } = maskPII("田中太郎と田中花子", [
      ...entries,
      { value: "田中花子", category: "STUDENT" },
    ]);
    // "田中太郎"/"田中花子" が "田中" より先に消費される
    expect(masked).toBe("{{STUDENT_002}}と{{STUDENT_003}}");
    expect(masked).not.toContain("田中");
  });

  it("同じ値の再出現には同一トークンを再利用する", () => {
    const entries: PiiEntry[] = [{ value: "佐藤", category: "STUDENT" }];
    const { masked, dictionary } = maskPII("佐藤、佐藤、佐藤", entries);
    expect(masked).toBe("{{STUDENT_001}}、{{STUDENT_001}}、{{STUDENT_001}}");
    expect(Object.keys(dictionary)).toHaveLength(1);
  });

  it("別名は同一トークンに集約され、逆変換で正規表記に戻る", () => {
    const entries: PiiEntry[] = [
      { value: "田中太郎", category: "STUDENT", aliases: ["田中 太郎", "タナカタロウ"] },
    ];
    const { masked, dictionary } = maskPII("田中 太郎 と タナカタロウ", entries);
    expect(masked).toBe("{{STUDENT_001}} と {{STUDENT_001}}");
    expect(unmaskPII(masked, dictionary)).toBe("田中太郎 と 田中太郎");
  });

  it("カテゴリごとに連番を振る", () => {
    const entries: PiiEntry[] = [
      { value: "山田", category: "STUDENT" },
      { value: "山田母", category: "GUARDIAN" },
      { value: "鈴木先生", category: "STAFF" },
    ];
    const { masked } = maskPII("山田 山田母 鈴木先生", entries);
    expect(masked).toBe("{{STUDENT_001}} {{GUARDIAN_001}} {{STAFF_001}}");
  });

  it("正規表現の特殊文字を含む値もリテラル置換する", () => {
    const entries: PiiEntry[] = [{ value: "A.B*C", category: "STUDENT" }];
    const { masked } = maskPII("連絡先 A.B*C まで", entries);
    expect(masked).toBe("連絡先 {{STUDENT_001}} まで");
  });

  it("空の値・空エントリは無視する", () => {
    const entries: PiiEntry[] = [{ value: "", category: "STUDENT" }];
    const { masked, dictionary } = maskPII("本文そのまま", entries);
    expect(masked).toBe("本文そのまま");
    expect(dictionary).toEqual({});
  });
});

describe("maskPII — パターン検出", () => {
  it("電話番号 (区切りあり/なし) を検出する", () => {
    const r1 = maskPII("連絡は 090-1234-5678 へ", []);
    expect(r1.masked).toBe("連絡は {{PHONE_001}} へ");
    const r2 = maskPII("0312345678 が代表", []);
    expect(r2.masked).toBe("{{PHONE_001}} が代表");
  });

  it("メールアドレスを検出する", () => {
    const { masked, dictionary } = maskPII("taro@example.ac.jp に送る", []);
    expect(masked).toBe("{{EMAIL_001}} に送る");
    expect(dictionary["{{EMAIL_001}}"]).toBe("taro@example.ac.jp");
  });

  it("トークン内部の数字を電話番号として誤検出しない", () => {
    const entries: PiiEntry[] = [{ value: "田中太郎", category: "STUDENT" }];
    const { masked } = maskPII("田中太郎", entries);
    expect(masked).toBe("{{STUDENT_001}}");
    // 再度パターンを掛けても PHONE は出ない
    expect(maskPII(masked, []).masked).toBe("{{STUDENT_001}}");
  });

  it("オプションでパターン検出を無効化できる", () => {
    const { masked } = maskPII("090-1234-5678 / a@b.co", [], {
      detectPhones: false,
      detectEmails: false,
    });
    expect(masked).toBe("090-1234-5678 / a@b.co");
  });
});

describe("unmaskPII", () => {
  it("マスク→逆変換でラウンドトリップする", () => {
    const entries: PiiEntry[] = [
      { value: "田中太郎", category: "STUDENT" },
      { value: "保護者花子", category: "GUARDIAN" },
    ];
    const original = "田中太郎さん (保護者花子) 090-1234-5678 / taro@example.jp";
    const { masked, dictionary } = maskPII(original, entries);
    expect(masked).not.toContain("田中太郎");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });

  it("10 件超でも前方一致誤爆なく復元する (長いトークン優先)", () => {
    const entries: PiiEntry[] = Array.from({ length: 12 }, (_, i) => ({
      value: `生徒${String(i).padStart(2, "0")}`,
      category: "STUDENT" as const,
    }));
    const original = entries.map((e) => e.value).join(" ");
    const { masked, dictionary } = maskPII(original, entries);
    expect(masked).toContain("{{STUDENT_010}}");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });
});

describe("findUnmaskedPii — fail-closed 検証", () => {
  it("正しくマスクされていれば残存ゼロ", () => {
    const entries: PiiEntry[] = [{ value: "田中太郎", category: "STUDENT" }];
    const { masked } = maskPII("田中太郎は欠席 090-0000-0000", entries);
    expect(findUnmaskedPii(masked, entries)).toEqual([]);
  });

  it("名簿値が残っていれば検出する", () => {
    const entries: PiiEntry[] = [{ value: "田中太郎", category: "STUDENT" }];
    // マスクせず生テキストを検証 → リーク検出
    expect(findUnmaskedPii("田中太郎は欠席", entries)).toContain("田中太郎");
  });

  it("マスク漏れの電話番号を検出する", () => {
    expect(findUnmaskedPii("代表 03-1111-2222", [])).toContain("03-1111-2222");
  });
});
