import { describe, expect, it } from "vitest";
import { findHonorificNames } from "../student-name-heuristic.js";

/**
 * F06 / #426 / ADR-030: authoring 時の生徒/保護者氏名（ロスター無し PII）検出ヒューリスティック。
 *
 * 高 precision（偽陽性を低く保つ）を最重要視するため、**偽陽性ケース（親族語・役職語・組織参照）が
 * 検出されない**ことを正例と同等以上の密度で縛る。recall は意図的に部分的（敬称無し・単漢字姓・
 * ひらがな名は取りこぼす = ADR-030 の受容済 Low）。
 */

describe("findHonorificNames — 正例（敬称連接の氏名を検出）", () => {
  it("ADR-030 の例: 「田中さんが県大会で優勝」を検出", () => {
    const d = findHonorificNames("田中さんが県大会で優勝");
    expect(d).toHaveLength(1);
    expect(d[0]).toEqual({ surface: "田中さん", name: "田中", honorific: "さん", index: 0 });
  });

  it("各個人敬称を検出: くん/ちゃん/君/様/氏/先輩", () => {
    const cases: [string, string, string][] = [
      ["佐藤くんは欠席", "佐藤", "くん"],
      ["鈴木ちゃんと遊ぶ", "鈴木", "ちゃん"],
      ["山田君が代表", "山田", "君"],
      ["高橋様より寄付", "高橋", "様"],
      ["田中氏のコメント", "田中", "氏"],
      ["渡辺先輩に相談", "渡辺", "先輩"],
    ];
    for (const [text, name, honorific] of cases) {
      const d = findHonorificNames(text);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ name, honorific });
    }
  });

  it("カタカナ氏名（外国籍）も検出", () => {
    const d = findHonorificNames("マリアさんとジョンくんが参加");
    expect(d.map((x) => x.name)).toEqual(["マリア", "ジョン"]);
  });

  it("複数出現を出現順・位置付きで列挙（同名も位置ごと）", () => {
    const text = "佐藤さん、鈴木さん、佐藤さん";
    const d = findHonorificNames(text);
    expect(d.map((x) => x.name)).toEqual(["佐藤", "鈴木", "佐藤"]);
    // index は NFKC 正規化後テキストの開始位置（warn ハイライト用）。
    expect(d.map((x) => x.index)).toEqual([0, text.indexOf("鈴木"), text.lastIndexOf("佐藤")]);
  });

  it("全角偽装は NFKC 正規化後も検出（mask.ts と同じ正規化規律）", () => {
    // 敬称・漢字は NFKC 不変だが、全角英数字混じり文でも漢字氏名+敬称は拾う。
    const d = findHonorificNames("（速報）田中さん、おめでとう");
    expect(d).toHaveLength(1);
    expect(d[0]?.name).toBe("田中");
  });
});

describe("findHonorificNames — 偽陽性ガード（検出しない）", () => {
  it("親族・呼称（お母さん/お父さん/お兄さん/皆さん）は氏名部 1 文字で除外", () => {
    for (const text of [
      "お母さんへ",
      "お父さんと",
      "お兄さんが",
      "お姉さんは",
      "皆さんこんにちは",
    ]) {
      expect(findHonorificNames(text)).toEqual([]);
    }
  });

  it("単漢字の一般語+敬称（神様/王様/奥様/お客様）は {2,4} 制約で除外", () => {
    for (const text of ["神様にお願い", "王様の命令", "奥様向け講座", "お客様各位"]) {
      expect(findHonorificNames(text)).toEqual([]);
    }
  });

  it("職業・役職語（店員さん/監督さん/会員さん/社員さん）は除外集合・末尾字で除外", () => {
    for (const text of [
      "店員さんに聞く",
      "監督さんの方針",
      "会員さん限定",
      "社員さん募集",
      "係員さんへ",
    ]) {
      expect(findHonorificNames(text)).toEqual([]);
    }
  });

  it("組織・集団・学年参照（サッカー部さん/一組さん/三年さん/実行委さん）は末尾字で除外", () => {
    for (const text of [
      "サッカー部さんへ",
      "一組さんと対戦",
      "三年さんを送る会",
      "実行委さんより",
    ]) {
      expect(findHonorificNames(text)).toEqual([]);
    }
  });

  it("カタカナ一般語（コーチさん/スタッフさん/メンバーさん）は除外", () => {
    for (const text of ["コーチさんへ", "スタッフさん募集", "メンバーさん各位"]) {
      expect(findHonorificNames(text)).toEqual([]);
    }
  });

  it("役職敬称「先生」は初期セット外（staff/役割語の曖昧さ回避）", () => {
    expect(findHonorificNames("田中先生の授業")).toEqual([]);
  });

  it("ひらがなのみの与え名は取りこぼす（高 precision 優先の既知 recall ギャップ）", () => {
    // 「さくらさん」はひらがな名のため検出しない（ADR-030 が Low 残存として受容）。
    expect(findHonorificNames("さくらさんと帰る")).toEqual([]);
  });

  it("敬称が無ければ検出しない", () => {
    expect(findHonorificNames("田中が県大会で優勝した")).toEqual([]);
    expect(findHonorificNames("")).toEqual([]);
  });
});

describe("findHonorificNames — 健全性", () => {
  it("呼び出し間で状態を持ち越さない（global regex の lastIndex 汚染が無い）", () => {
    const text = "佐藤さんと鈴木さん";
    const first = findHonorificNames(text);
    const second = findHonorificNames(text);
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });

  it("長文・多数出現でも線形に完了する（ReDoS 不能の素集合 + 上限量化子）", () => {
    const text = `${"田中さん、".repeat(500)}終わり`;
    const d = findHonorificNames(text);
    expect(d).toHaveLength(500);
  });
});
