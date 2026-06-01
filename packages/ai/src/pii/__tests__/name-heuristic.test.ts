import { describe, expect, it } from "vitest";
import {
  EXCLUDED_BASE,
  HONORIFICS,
  findSuspectedPersonalNames,
  hasSuspectedPersonalName,
} from "../name-heuristic.js";

/**
 * #426 / ADR-030: 掲示物 authoring 時のロスター無し PII (生徒/保護者氏名) soft-gate 検出器のテスト。
 * 高確信パターン (氏名 + ひらがな敬称) を検出し、一般語の FP を抑えることを pin する。warn-only なので
 * ひらがな名/敬称無し/漢字敬称 (君・様, deferred) の FN は許容 (ADR-030 の Low 残存リスク)。検出すべき/
 * すべきでない代表ケースを固定する。
 */

describe("findSuspectedPersonalNames — 検出すべき (敬称連接)", () => {
  it("漢字氏名 + さん を検出し、name/honorific/index を返す", () => {
    const hits = findSuspectedPersonalNames("田中さんが県大会で優勝");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ surface: "田中さん", name: "田中", honorific: "さん", index: 0 });
  });

  it("くん / ちゃん も検出する", () => {
    expect(findSuspectedPersonalNames("佐藤くんと話した")[0]).toMatchObject({
      name: "佐藤",
      honorific: "くん",
    });
    expect(findSuspectedPersonalNames("リンちゃんは元気")[0]).toMatchObject({
      name: "リン",
      honorific: "ちゃん",
    });
  });

  it("カタカナ氏名・フルネームも検出する", () => {
    expect(findSuspectedPersonalNames("スズキさんが来た")[0]?.name).toBe("スズキ");
    // 姓 + 名の連結 (上限 5 文字以内)。
    expect(findSuspectedPersonalNames("田中太郎さんは欠席")[0]?.name).toBe("田中太郎");
  });

  it("複数の氏名を独立に検出し、それぞれの index を返す", () => {
    const text = "田中さんと佐藤さんが参加";
    const hits = findSuspectedPersonalNames(text);
    expect(hits.map((h) => h.name)).toEqual(["田中", "佐藤"]);
    expect(hits[1]?.index).toBe(text.indexOf("佐藤"));
  });
});

describe("findSuspectedPersonalNames — 検出すべきでない (FP 抑制)", () => {
  it("親族・呼称の一般語 (お母さん/赤ちゃん/兄ちゃん/坊ちゃん) は除外", () => {
    for (const t of ["お母さん", "赤ちゃん", "兄ちゃん", "お姉さん", "お父さん", "坊ちゃん"]) {
      expect(findSuspectedPersonalNames(t), t).toEqual([]);
    }
  });

  it("集合・敬称一般 (皆さん/神さん/お客さん) は除外", () => {
    for (const t of ["皆さんこんにちは", "神さんに願う", "お客さん各位"]) {
      expect(findSuspectedPersonalNames(t), t).toEqual([]);
    }
  });

  it("学校文脈の集合語 (生徒さん/新入生さん) は除外", () => {
    for (const t of ["生徒さんへ", "新入生さん歓迎"]) {
      expect(findSuspectedPersonalNames(t), t).toEqual([]);
    }
  });

  it("漢字敬称 (君/様) は本スライス対象外 — 漢語複合語 (同様/仕様/模様/諸君) を誤検出しない", () => {
    for (const t of [
      "前回と同様に実施",
      "仕様書を確認",
      "市松模様の幕",
      "多様な意見",
      "諸君に告ぐ",
    ]) {
      expect(findSuspectedPersonalNames(t), t).toEqual([]);
    }
  });

  it("ひらがな名 (みなさん/おかあさん) は構造上対象外 (FP 抑制の設計)", () => {
    for (const t of ["みなさんこんにちは", "おかあさんと来る", "こんにちは"]) {
      expect(findSuspectedPersonalNames(t), t).toEqual([]);
    }
  });

  it("敬称が無ければ検出しない", () => {
    expect(findSuspectedPersonalNames("田中が優勝した")).toEqual([]);
    expect(findSuspectedPersonalNames("")).toEqual([]);
  });
});

describe("hasSuspectedPersonalName", () => {
  it("検出があれば true、無ければ false", () => {
    expect(hasSuspectedPersonalName("田中さんが優勝")).toBe(true);
    expect(hasSuspectedPersonalName("生徒のみなさんへ")).toBe(false);
    expect(hasSuspectedPersonalName("")).toBe(false);
  });
});

describe("ReDoS 不能性 / 公開定数", () => {
  it("長大な name 文字列でも線形に完了する (上限付き量化子)", () => {
    const huge = `${"漢".repeat(100_000)}さん`;
    // ハングせず返ること自体が線形評価の確認 (上限 {1,5} + 素な文字クラス + 名前境界 lookbehind)。
    expect(() => findSuspectedPersonalNames(huge)).not.toThrow();
  });

  it("HONORIFICS / EXCLUDED_BASE を公開し、配線スライスでのチューニングを可能にする", () => {
    expect(HONORIFICS).toContain("さん");
    expect(EXCLUDED_BASE.has("生徒")).toBe(true);
  });
});
