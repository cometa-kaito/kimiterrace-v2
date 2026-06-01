import type { AdReachByAd, MonthlySchoolSummary } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import { type MonthlyReportPdfData, loadDefaultJpFont, renderMonthlyReportPdf } from "../pdf.js";

/**
 * F09 (#45) PDF レンダラのユニットテスト。
 *
 * 生成 Buffer が有効な PDF (`%PDF-` ヘッダ) で非自明なサイズを持ち、入力データ (校名・指標値・content
 * タイトル・広告 caption) が**実際に描画されている**ことを、`pdfjs-dist` (リポジトリ既存依存) のテキスト
 * 抽出で検証する。フォントは同梱の Noto Sans JP を `loadDefaultJpFont()` で読み、CJK 込みのテキストが
 * 埋め込みフォント経由で round-trip することを確かめる。
 */

/** pdfjs-dist で PDF Buffer から全ページのテキストを連結抽出する。 */
async function extractPdfText(pdf: Buffer): Promise<{ numPages: number; text: string }> {
  // legacy build は Node から fake worker で動く (DOMMatrix 等の DOM 依存を避ける)。
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: false,
  }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str : "")).join("");
  }
  return { numPages: doc.numPages, text };
}

const SCHOOL_NAME = "岐南工業高等学校";

const SUMMARY: MonthlySchoolSummary = {
  year: 2026,
  month: 6,
  totals: { view: 1234, tap: 56, ask: 7 },
  ranking: [
    { contentId: "c1", title: "体育祭のお知らせ", views: 800, taps: 40, total: 840 },
    { contentId: "c2", title: "図書館 開館時間", views: 300, taps: 10, total: 310 },
  ],
  activeDays: 21,
};

const AD_REACH: AdReachByAd[] = [
  { adId: "a1", caption: "地元書店フェア", reach: 512 },
  { adId: "a2", caption: null, reach: 33 },
];

const DATA: MonthlyReportPdfData = {
  schoolName: SCHOOL_NAME,
  summary: SUMMARY,
  adReach: AD_REACH,
};

describe("renderMonthlyReportPdf", () => {
  it("有効な PDF (先頭 %PDF-) を非自明なサイズで返す", async () => {
    const pdf = await renderMonthlyReportPdf(DATA, { font: loadDefaultJpFont() });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    // %PDF- ヘッダ。
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    // %%EOF トレーラ。
    expect(pdf.subarray(-32).toString("ascii")).toContain("%%EOF");
    // 日本語フォント埋め込みで非自明なサイズになる (空 PDF は数百 B)。
    expect(pdf.byteLength).toBeGreaterThan(2000);
  });

  it("校名・対象月・指標値が描画される (テキスト抽出で検証)", async () => {
    const pdf = await renderMonthlyReportPdf(DATA, { font: loadDefaultJpFont() });
    const { numPages, text } = await extractPdfText(pdf);
    expect(numPages).toBeGreaterThanOrEqual(1);
    expect(text).toContain(SCHOOL_NAME);
    expect(text).toContain("2026年6月");
    // 指標値 (view/tap/ask/稼働日数)。
    expect(text).toContain("1234");
    expect(text).toContain("56");
    expect(text).toContain("21");
  });

  it("コンテンツランキングの title が描画される", async () => {
    const pdf = await renderMonthlyReportPdf(DATA, { font: loadDefaultJpFont() });
    const { text } = await extractPdfText(pdf);
    expect(text).toContain("体育祭のお知らせ");
    expect(text).toContain("図書館 開館時間");
  });

  it("広告別 到達数 (caption + reach) が描画され、caption=null は無題ラベルになる", async () => {
    const pdf = await renderMonthlyReportPdf(DATA, { font: loadDefaultJpFont() });
    const { text } = await extractPdfText(pdf);
    expect(text).toContain("地元書店フェア");
    expect(text).toContain("512");
    // caption=null は「（無題の広告）」ラベル + reach。
    expect(text).toContain("無題の広告");
    expect(text).toContain("33");
  });

  it("ranking / adReach が空でも有効な PDF を生成する (版面構造を保つ)", async () => {
    const empty: MonthlyReportPdfData = {
      schoolName: SCHOOL_NAME,
      summary: { ...SUMMARY, ranking: [], totals: { view: 0, tap: 0, ask: 0 }, activeDays: 0 },
      adReach: [],
    };
    const pdf = await renderMonthlyReportPdf(empty, { font: loadDefaultJpFont() });
    const { text } = await extractPdfText(pdf);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(text).toContain(SCHOOL_NAME);
    expect(text).toContain("反応はありません");
    expect(text).toContain("広告到達はありません");
  });

  it("opts.font 未指定でも同梱フォントを読んで描画する", async () => {
    // loadDefaultJpFont のフォールバック解決を通る経路。
    const pdf = await renderMonthlyReportPdf(DATA);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(2000);
  });

  it("loadDefaultJpFont は同梱 OTF を Buffer で返す (magic OTTO)", () => {
    const font = loadDefaultJpFont();
    expect(Buffer.isBuffer(font)).toBe(true);
    // OTF (CFF) の magic は "OTTO"。
    expect(font.subarray(0, 4).toString("ascii")).toBe("OTTO");
  });
});
