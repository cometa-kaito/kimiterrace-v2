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

// F06 多言語チャットボット: 主要外国語（英語・ポルトガル語・やさしい日本語等）でもマスクが機能すること。
// 設計上、名簿置換はリテラル一致で文字体系非依存、メールは ASCII で言語非依存。日本語前提だったのは
// 電話検出のみだったため、ここでは国際電話・外国語名簿・別名（表記体系の橋渡し）を言語別に固定する。
describe("maskPII — 多言語 (F06: 主要外国語)", () => {
  it("英語: ラテン文字氏名 + 北米 国際電話 (+1)", () => {
    const entries: PiiEntry[] = [{ value: "John Smith", category: "STUDENT" }];
    const { masked, dictionary } = maskPII("John Smith called +1-202-555-0173", entries);
    expect(masked).toBe("{{STUDENT_001}} called {{PHONE_001}}");
    expect(dictionary["{{PHONE_001}}"]).toBe("+1-202-555-0173");
  });

  it("ポルトガル語: 保護者氏名 + ブラジル 国際電話 (+55)", () => {
    const entries: PiiEntry[] = [{ value: "Ana Souza", category: "GUARDIAN" }];
    const { masked } = maskPII("Ana Souza: +55 11 91234-5678", entries);
    expect(masked).toBe("{{GUARDIAN_001}}: {{PHONE_001}}");
  });

  it("やさしい日本語: ひらがな別名を正規表記（漢字）に集約して逆変換する", () => {
    const entries: PiiEntry[] = [
      { value: "山田花子", category: "STUDENT", aliases: ["やまだ はなこ", "ヤマダハナコ"] },
    ];
    const { masked, dictionary } = maskPII(
      "やまだ はなこ さんの でんわは 090-1234-5678 です",
      entries,
    );
    expect(masked).toBe("{{STUDENT_001}} さんの でんわは {{PHONE_001}} です");
    expect(unmaskPII(masked, dictionary)).toBe("山田花子 さんの でんわは 090-1234-5678 です");
  });

  it("外国ドメインのメールも検出する (言語非依存)", () => {
    const { masked, dictionary } = maskPII("メールは maria@escola.com.br へ", []);
    expect(masked).toBe("メールは {{EMAIL_001}} へ");
    expect(dictionary["{{EMAIL_001}}"]).toBe("maria@escola.com.br");
  });

  it("各国番号の国際電話 (E.164) を区切り差異込みで検出する", () => {
    for (const phone of [
      "+44 20 7946 0958", // 英国
      "+63 917 123 4567", // フィリピン
      "+1 (202) 555-0173", // 北米（括弧区切り）
      "+8613800138000", // 中国（区切りなし）
      "+49 30/12345678", // 独語圏（スラッシュ区切り）
    ]) {
      const { masked, dictionary } = maskPII(`連絡先: ${phone}`, []);
      expect(masked).toBe("連絡先: {{PHONE_001}}");
      expect(dictionary["{{PHONE_001}}"]).toBe(phone);
    }
  });

  it("名簿氏名 + 国際電話 + 外国メールのラウンドトリップ", () => {
    const entries: PiiEntry[] = [{ value: "Maria Silva", category: "GUARDIAN" }];
    const original = "Maria Silva (+55 11 91234-5678) maria@escola.com.br";
    const { masked, dictionary } = maskPII(original, entries);
    expect(masked).not.toContain("Maria Silva");
    expect(masked).not.toContain("+55");
    expect(unmaskPII(masked, dictionary)).toBe(original);
  });

  it("fail-closed: マスク漏れの国際電話を検出する", () => {
    expect(findUnmaskedPii("Brazil guardian +55 11 91234-5678", [])).toContain("+55 11 91234-5678");
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
