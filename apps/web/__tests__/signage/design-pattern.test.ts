import {
  DEFAULT_SIGNAGE_DESIGN_PATTERN,
  SIGNAGE_DESIGN_PATTERNS,
  SIGNAGE_SCHEDULE_DAY_COUNT,
  applyDesignPatternToUrl,
  getDesignPatternFromUrl,
  isSignageDesignPattern,
  parseSignageDesignPattern,
  resolveDesignPattern,
  signageScheduleDayCount,
  stripDesignParam,
} from "@/lib/signage/design-pattern";
import { describe, expect, it } from "vitest";

/**
 * 端末別サイネージデザイン（`tv_devices.signage_url` の `?design=patternN` で保持・スキーマ非変更）の
 * client-safe な定義・型ガード・URL 合成/抽出ヘルパの単体テスト。管理 UI（TV 設定編集）と公開サイネージ
 * ページの両方がこのロジックで端末別デザインを往復させる。未知値・パース不能はすべて既定 pattern1 に倒す
 * （fail-soft）。
 */

describe("isSignageDesignPattern", () => {
  it("既知パターン（pattern1 / pattern2 / pattern3 / pattern4 / pattern5）のみ true", () => {
    expect(isSignageDesignPattern("pattern1")).toBe(true);
    expect(isSignageDesignPattern("pattern2")).toBe(true);
    expect(isSignageDesignPattern("pattern3")).toBe(true);
    expect(isSignageDesignPattern("pattern4")).toBe(true);
    expect(isSignageDesignPattern("pattern5")).toBe(true);
    expect(isSignageDesignPattern("pattern6")).toBe(true);
    expect(isSignageDesignPattern("pattern999")).toBe(false);
    expect(isSignageDesignPattern("")).toBe(false);
    expect(isSignageDesignPattern(null)).toBe(false);
    expect(isSignageDesignPattern(123)).toBe(false);
  });
  it("既定は pattern1", () => {
    expect(DEFAULT_SIGNAGE_DESIGN_PATTERN).toBe("pattern1");
  });
});

describe("signageScheduleDayCount（予定セクションの表示日数 = 列数の単一ソース・パターン別）", () => {
  it("パターン別の既定日数を返す（日数を変えるのはここ 1 か所）", () => {
    // #1127 で全パターン共通 5 日になり pattern1/2 も 5 日化していたのをパターン別に分離し直した回帰固定。
    expect(signageScheduleDayCount("pattern1")).toBe(3);
    expect(signageScheduleDayCount("pattern2")).toBe(3);
    expect(signageScheduleDayCount("pattern3")).toBe(5);
    // pattern4 は予定を描画しないため 0（= データ取得もしない）。
    expect(signageScheduleDayCount("pattern4")).toBe(0);
    // pattern5（掲示板型）は「今日の予定」1 列のみ（多日グリッドを出さない・editor-restructure §6.1）。
    expect(signageScheduleDayCount("pattern5")).toBe(1);
    // pattern6（枠なし罫線区切り）は pattern1 と同一内容なので 3（囲み枠→罫線のデザイン差のみ）。
    expect(signageScheduleDayCount("pattern6")).toBe(3);
  });
  it("全パターンに 0 以上の数値が定義されている（漏れをランタイムでも防ぐ）", () => {
    for (const p of SIGNAGE_DESIGN_PATTERNS) {
      expect(typeof SIGNAGE_SCHEDULE_DAY_COUNT[p]).toBe("number");
      expect(SIGNAGE_SCHEDULE_DAY_COUNT[p]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("parseSignageDesignPattern（学校レベル config の defensive 解決）", () => {
  it("display_settings.signageDesign が既知なら採用、それ以外は既定", () => {
    expect(parseSignageDesignPattern({ signageDesign: "pattern2" })).toBe("pattern2");
    expect(parseSignageDesignPattern({ signageDesign: "pattern1" })).toBe("pattern1");
    expect(parseSignageDesignPattern({ signageDesign: "bogus" })).toBe("pattern1");
    expect(parseSignageDesignPattern(null)).toBe("pattern1");
    expect(parseSignageDesignPattern({})).toBe("pattern1");
    expect(parseSignageDesignPattern("pattern2")).toBe("pattern1"); // 非オブジェクトは既定
  });
});

describe("getDesignPatternFromUrl（signage_url の ?design 抽出）", () => {
  it("?design が既知パターンなら返す", () => {
    expect(getDesignPatternFromUrl("https://app.example/signage/tok?design=pattern2")).toBe(
      "pattern2",
    );
    expect(getDesignPatternFromUrl("https://app.example/signage/tok?x=1&design=pattern1")).toBe(
      "pattern1",
    );
  });
  it("未指定・未知・パース不能（相対/空/null）は null（呼出側で既定に倒す）", () => {
    expect(getDesignPatternFromUrl("https://app.example/signage/tok")).toBeNull();
    expect(getDesignPatternFromUrl("https://app.example/signage/tok?design=bogus")).toBeNull();
    expect(getDesignPatternFromUrl("/signage/tok?design=pattern2")).toBeNull(); // 相対は parse 不能
    expect(getDesignPatternFromUrl("")).toBeNull();
    expect(getDesignPatternFromUrl(null)).toBeNull();
  });
});

describe("resolveDesignPattern（端末別 ?design > 学校レベル既定 の解決・エディタ/壁の単一ソース）", () => {
  it("URL に ?design があれば最優先で採用する（学校既定より端末別が勝つ）", () => {
    expect(
      resolveDesignPattern("https://app.example/signage/tok?design=pattern2", "pattern1"),
    ).toBe("pattern2");
    // 学校既定が pattern3 でも端末が pattern1 を明示していればそれを採る。
    expect(
      resolveDesignPattern("https://app.example/signage/tok?design=pattern1", "pattern3"),
    ).toBe("pattern1");
  });
  it("?design 未指定・未知・パース不能・未設置（null）は学校レベル既定に倒す", () => {
    expect(resolveDesignPattern("https://app.example/signage/tok", "pattern2")).toBe("pattern2");
    expect(resolveDesignPattern("https://app.example/signage/tok?design=bogus", "pattern3")).toBe(
      "pattern3",
    );
    expect(resolveDesignPattern("/relative?design=pattern2", "pattern1")).toBe("pattern1");
    expect(resolveDesignPattern(undefined, "pattern2")).toBe("pattern2");
    expect(resolveDesignPattern(null, "pattern1")).toBe("pattern1");
  });
});

describe("stripDesignParam（フォームの URL 欄に見せる素の URL）", () => {
  it("design クエリだけ除去し他のクエリは保つ", () => {
    expect(stripDesignParam("https://app.example/s?x=1&design=pattern2")).toBe(
      "https://app.example/s?x=1",
    );
    expect(stripDesignParam("https://app.example/s?design=pattern2")).toBe("https://app.example/s");
  });
  it("design 無し・パース不能・空は原文をそのまま返す（正規化しない）", () => {
    expect(stripDesignParam("https://app.example/s?x=1")).toBe("https://app.example/s?x=1");
    expect(stripDesignParam("/relative?design=pattern2")).toBe("/relative?design=pattern2");
    expect(stripDesignParam("")).toBe("");
    expect(stripDesignParam(null)).toBe("");
  });
});

describe("applyDesignPatternToUrl（保存時の合成）", () => {
  it("pattern2 は ?design=pattern2 を設定（既存クエリは保つ）", () => {
    expect(applyDesignPatternToUrl("https://app.example/s", "pattern2")).toBe(
      "https://app.example/s?design=pattern2",
    );
    expect(applyDesignPatternToUrl("https://app.example/s?x=1", "pattern2")).toBe(
      "https://app.example/s?x=1&design=pattern2",
    );
  });
  it("pattern1（既定）は design を付けない（後方互換・URL を汚さない）", () => {
    // 元から design 無し → 原文維持（正規化しない）。
    expect(applyDesignPatternToUrl("https://app.example/s", "pattern1")).toBe(
      "https://app.example/s",
    );
    // 元の design を除去して base に戻す。
    expect(applyDesignPatternToUrl("https://app.example/s?design=pattern2", "pattern1")).toBe(
      "https://app.example/s",
    );
  });
  it("既存 design は置換する（二重に付かない）", () => {
    expect(applyDesignPatternToUrl("https://app.example/s?design=pattern1", "pattern2")).toBe(
      "https://app.example/s?design=pattern2",
    );
  });
  it("パース不能（相対）は原文を返す（fail-soft。呼出側で http(s) 絶対を事前検証済み）", () => {
    expect(applyDesignPatternToUrl("/relative", "pattern2")).toBe("/relative");
  });
  it("往復: apply → getFromUrl で同じパターンに戻る", () => {
    const url = applyDesignPatternToUrl(
      "https://app.example/signage/tok?date=2026-06-10",
      "pattern2",
    );
    expect(getDesignPatternFromUrl(url)).toBe("pattern2");
  });
});
