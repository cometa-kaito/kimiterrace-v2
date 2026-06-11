import { describe, expect, it } from "vitest";
import { redactSuspectedNames } from "../name-heuristic.js";

/**
 * ISSUE-1(b) (Opus 検証): roster 非存在の生徒/保護者氏名 (ADR-030 Low 残存) を Vertex 送信 /
 * 監査ビューア表示の前に best-effort 伏字化する `redactSuspectedNames` のガード。
 * **確定マスクではない** (漢字敬称 `君`/`様`・ひらがな名は対象外・ADR-030) ＝保証ではなく低減。
 */
describe("redactSuspectedNames: 氏名+ひらがな敬称を best-effort 伏字化", () => {
  it("氏名部分のみ伏字・敬称は残す", () => {
    expect(redactSuspectedNames("田中さんが県大会で優勝")).toBe("●●さんが県大会で優勝");
    expect(redactSuspectedNames("佐藤くんと山田ちゃん")).toBe("●●くんと●●ちゃん");
  });

  it("一般語 (皆さん / 生徒さん 等) は EXCLUDED_BASE で伏字しない", () => {
    expect(redactSuspectedNames("皆さんこんにちは")).toBe("皆さんこんにちは");
    expect(redactSuspectedNames("生徒さんへ連絡")).toBe("生徒さんへ連絡");
  });

  it("敬称が無ければ変えない (ADR-030: 確定マスクでなく低減・漢字敬称/ひらがな名は対象外)", () => {
    expect(redactSuspectedNames("文化祭の集合時間は何時ですか？")).toBe(
      "文化祭の集合時間は何時ですか？",
    );
  });

  it("既存の {{STUDENT_001}} トークンには触れない (逆変換しない)", () => {
    expect(redactSuspectedNames("{{STUDENT_001}}は欠席です")).toBe("{{STUDENT_001}}は欠席です");
  });
});
