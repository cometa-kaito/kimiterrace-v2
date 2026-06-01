import type { AdReachByAd, MonthlySchoolSummary } from "@kimiterrace/db";
import { describe, expect, it, vi } from "vitest";
import type { MonthlyReportPdfData } from "../pdf.js";
import { renderAllMonthlyReports } from "../run.js";

/**
 * F09 (#45 第2スライス): `renderAllMonthlyReports`（全校横断オーケストレーション）をフェイク依存で
 * 単体検証する。実 PG / RLS の振る舞いは packages/db の集計クエリテスト（`monthly-report.test.ts` /
 * `ad-reach.test.ts`）、PDF 実描画は `pdf.test.ts` がカバーするため、ここでは「全校を順に処理し、各校の
 * 集計 + 校名を正しく renderPdf へ渡し、結果を集計する」不変条件のみを検証する（DB/pdfkit 非依存）。
 */

/** 最小の有効な MonthlySchoolSummary（ranking は空で ContentEngagement の詳細に依存しない）。 */
function fakeSummary(year: number, month: number): MonthlySchoolSummary {
  return { year, month, totals: { view: 0, tap: 0, ask: 0 }, ranking: [], activeDays: 0 };
}

describe("renderAllMonthlyReports", () => {
  it("全校を順に処理し、校ごとに PDF を生成して集計する", async () => {
    const captured: MonthlyReportPdfData[] = [];
    const result = await renderAllMonthlyReports({
      year: 2026,
      month: 5,
      listSchools: async () => [
        { id: "school-A", name: "A高校" },
        { id: "school-B", name: "B高校" },
      ],
      loadReportData: async (schoolId) => ({
        summary: fakeSummary(2026, 5),
        adReach: schoolId === "school-A" ? [{ adId: "ad1", reach: 3, caption: "広告1" }] : [],
      }),
      renderPdf: async (data) => {
        captured.push(data);
        return Buffer.from(`PDF:${data.schoolName}`);
      },
    });

    expect(result.year).toBe(2026);
    expect(result.month).toBe(5);
    expect(result.schools).toBe(2);
    expect(result.reports.map((r) => [r.schoolId, r.schoolName, r.pdf.toString()])).toEqual([
      ["school-A", "A高校", "PDF:A高校"],
      ["school-B", "B高校", "PDF:B高校"],
    ]);
    // renderPdf に各校の校名 + その校の集計（広告到達）が渡る。
    expect(captured.map((d) => d.schoolName)).toEqual(["A高校", "B高校"]);
    expect(captured[0]?.adReach).toEqual([{ adId: "ad1", reach: 3, caption: "広告1" }]);
    expect(captured[1]?.adReach).toEqual([]);
  });

  it("loadReportData を校ごとに 1 回ずつ呼ぶ（順序保持）", async () => {
    const load = vi.fn(async (_schoolId: string) => ({
      summary: fakeSummary(2026, 1),
      adReach: [] as AdReachByAd[],
    }));
    await renderAllMonthlyReports({
      year: 2026,
      month: 1,
      listSchools: async () => [
        { id: "s1", name: "1" },
        { id: "s2", name: "2" },
        { id: "s3", name: "3" },
      ],
      loadReportData: load,
      renderPdf: async () => Buffer.from("x"),
    });
    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls.map((c) => c[0])).toEqual(["s1", "s2", "s3"]);
  });

  it("空の学校一覧なら PDF を 1 件も作らず 0 集計", async () => {
    const renderPdf = vi.fn(async () => Buffer.from("x"));
    const result = await renderAllMonthlyReports({
      year: 2026,
      month: 12,
      listSchools: async () => [],
      loadReportData: async () => ({ summary: fakeSummary(2026, 12), adReach: [] }),
      renderPdf,
    });
    expect(result).toEqual({ year: 2026, month: 12, schools: 0, reports: [] });
    expect(renderPdf).not.toHaveBeenCalled();
  });
});
