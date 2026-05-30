import { describe, expect, it } from "vitest";
import { maskPII } from "../pii/mask.js";

// M1/M2 フォロー: パターン検出を上限付き量化子で線形化（ReDoS 排除）しつつ +81 国際電話を追加。
describe("PII パターン検出（bounded / 国際電話）", () => {
  it("+81 国際電話を検出する（区切り任意）", () => {
    expect(maskPII("+81-90-1234-5678 へ", []).masked).toBe("{{PHONE_001}} へ");
    expect(maskPII("+819012345678", []).masked).toBe("{{PHONE_001}}");
  });

  it("既存の国内電話・メールは引き続き検出する", () => {
    expect(maskPII("090-1234-5678", []).masked).toBe("{{PHONE_001}}");
    expect(maskPII("0312345678", []).masked).toBe("{{PHONE_001}}");
    expect(maskPII("taro@example.ac.jp", []).masked).toBe("{{EMAIL_001}}");
  });

  it("病的に長い入力でも線形時間で完了する（ReDoS 回帰防止）", () => {
    // 上限付き量化子なら数十万文字でも実用時間で返る（旧 unbounded 版は O(n^2) でブロックした）。
    const hostile = `${"a".repeat(200_000)}@${"b".repeat(200_000)}`;
    const start = process.hrtime.bigint();
    maskPII(hostile, []);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(3000);
  });
});
