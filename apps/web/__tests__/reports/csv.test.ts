import type { AdReachByAd, MonthlySchoolSummary } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  escapeCsvField,
  monthlyCsvFilename,
  monthlySummaryToCsv,
  neutralizeCsvFormula,
} from "../../lib/reports/csv";

/**
 * F09 (#45): 月次サマリー CSV シリアライズの単体テスト。純粋関数なので DB 不要。
 * RFC 4180 のエスケープ・BOM・ブロック構成 (サマリー + 広告別到達数)・ファイル名規約を検証する。
 */

const baseSummary: MonthlySchoolSummary = {
  year: 2026,
  month: 6,
  totals: { view: 1234, tap: 56, ask: 7 },
  activeDays: 20,
  ranking: [
    { contentId: "c1", title: "体育祭のお知らせ", views: 100, taps: 30, total: 130 },
    { contentId: "c2", title: "図書だより", views: 40, taps: 5, total: 45 },
  ],
};

const baseAdReach: AdReachByAd[] = [
  { adId: "a1", caption: "スポンサー広告A", reach: 42 },
  { adId: "a2", caption: null, reach: 7 },
];

describe("escapeCsvField", () => {
  it("特殊文字を含まない値はそのまま", () => {
    expect(escapeCsvField("お知らせ")).toBe("お知らせ");
    expect(escapeCsvField(42)).toBe("42");
  });

  it("カンマを含む値は二重引用符で囲む", () => {
    expect(escapeCsvField("体育祭, 雨天時")).toBe('"体育祭, 雨天時"');
  });

  it("二重引用符は倍化して囲む", () => {
    expect(escapeCsvField('彼は"来る"と言った')).toBe('"彼は""来る""と言った"');
  });

  it("改行 (LF/CRLF) を含む値は囲む", () => {
    expect(escapeCsvField("1行目\n2行目")).toBe('"1行目\n2行目"');
    expect(escapeCsvField("1行目\r\n2行目")).toBe('"1行目\r\n2行目"');
  });
});

describe("neutralizeCsvFormula (CWE-1236)", () => {
  it("数式トリガ文字で始まる値は ' を前置する", () => {
    expect(neutralizeCsvFormula("=1+1")).toBe("'=1+1");
    expect(neutralizeCsvFormula("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(neutralizeCsvFormula("-2")).toBe("'-2");
    expect(neutralizeCsvFormula("@cmd")).toBe("'@cmd");
    expect(neutralizeCsvFormula("\tTAB")).toBe("'\tTAB");
  });

  it("通常のタイトルはそのまま", () => {
    expect(neutralizeCsvFormula("体育祭のお知らせ")).toBe("体育祭のお知らせ");
    expect(neutralizeCsvFormula("図書だより 6月号")).toBe("図書だより 6月号");
  });
});

describe("monthlySummaryToCsv", () => {
  it("BOM で始まり CRLF 区切りで終わる", () => {
    const csv = monthlySummaryToCsv(baseSummary, []);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    // レコード区切りは CRLF (素の LF を使っていない)。
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("ヘッダ・指標・ランキング・広告別到達数の 4 ブロックを空行で区切る", () => {
    const lines = monthlySummaryToCsv(baseSummary, baseAdReach).replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("キミテラス 月次レポート,2026年6月");
    expect(lines[1]).toBe("集計基準,日本時間(JST) 暦月");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("指標,件数");
    // 桁区切りを入れず生の整数で出す (表計算が数値として扱える)。
    expect(lines[4]).toBe("延べ表示数 (engagement),1234");
    expect(lines[5]).toBe("タップ (tap),56");
    expect(lines[6]).toBe("Q&A (ask),7");
    expect(lines[7]).toBe("稼働日数,20");
    expect(lines[8]).toBe("");
    expect(lines[9]).toBe("順位,コンテンツ,表示,タップ,合計");
    expect(lines[10]).toBe("1,体育祭のお知らせ,100,30,130");
    expect(lines[11]).toBe("2,図書だより,40,5,45");
    // 第4ブロック: 広告別 到達数 (reach)。caption null は「（無題の広告）」表示。
    expect(lines[12]).toBe("");
    expect(lines[13]).toBe("広告,到達数 (reach)");
    expect(lines[14]).toBe("スポンサー広告A,42");
    expect(lines[15]).toBe("（無題の広告）,7");
  });

  it("ランキングが空でも列ヘッダ行は出す", () => {
    const csv = monthlySummaryToCsv({ ...baseSummary, ranking: [] }, []);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines).toContain("順位,コンテンツ,表示,タップ,合計");
    // ヘッダの次はデータ行が無く末尾の空文字 (trailing CRLF) のみ。
    const idx = lines.indexOf("順位,コンテンツ,表示,タップ,合計");
    expect(lines[idx + 1]).toBe("");
  });

  it("数式始まりのタイトルは中和されてから出る (formula injection 防止)", () => {
    const csv = monthlySummaryToCsv(
      {
        ...baseSummary,
        ranking: [{ contentId: "c1", title: '=HYPERLINK("evil")', views: 1, taps: 0, total: 1 }],
      },
      [],
    );
    // 先頭 ' が前置され、さらに " を含むため RFC4180 で引用される。
    expect(csv).toContain('1,"\'=HYPERLINK(""evil"")",1,0,1');
  });

  it("コンテンツ名にカンマがあってもエスケープされ列がずれない", () => {
    const csv = monthlySummaryToCsv(
      {
        ...baseSummary,
        ranking: [{ contentId: "c1", title: "運動会, 雨天延期", views: 1, taps: 2, total: 3 }],
      },
      [],
    );
    expect(csv).toContain('1,"運動会, 雨天延期",1,2,3');
  });

  it("広告別到達数ブロック: caption の formula injection を中和し、null は無題ラベルにする", () => {
    const csv = monthlySummaryToCsv({ ...baseSummary, ranking: [] }, [
      { adId: "a1", caption: "=1+1", reach: 99 }, // 数式始まり → ' 前置で中和 (特殊文字なしなので引用なし)
      { adId: "a2", caption: "+SUM(A1),B1", reach: 5 }, // 数式始まり + カンマ → 中和してから RFC4180 で引用
      { adId: "a3", caption: null, reach: 3 }, // 未設定 → 無題ラベル
    ]);
    expect(csv).toContain("'=1+1,99");
    expect(csv).toContain('"\'+SUM(A1),B1",5');
    expect(csv).toContain("（無題の広告）,3");
  });

  it("広告別到達数が空でも列ヘッダ行は出す (列構造を一定に保つ)", () => {
    const csv = monthlySummaryToCsv(baseSummary, []);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines).toContain("広告,到達数 (reach)");
    // ヘッダの次はデータ行が無く末尾の空文字 (trailing CRLF) のみ。
    const idx = lines.indexOf("広告,到達数 (reach)");
    expect(lines[idx + 1]).toBe("");
  });
});

describe("monthlyCsvFilename", () => {
  it("YYYY-MM をゼロ埋めした ASCII ファイル名", () => {
    expect(monthlyCsvFilename(2026, 6)).toBe("monthly-report-2026-06.csv");
    expect(monthlyCsvFilename(2026, 12)).toBe("monthly-report-2026-12.csv");
  });
});
