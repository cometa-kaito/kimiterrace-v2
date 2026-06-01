import { describe, expect, it, vi } from "vitest";
import type { ReportPersistInput, ReportPersistPort } from "../persist-port.js";
import { type SchoolMonthlyReport, persistAllMonthlyReports } from "../run.js";
import type { ReportStoragePort } from "../storage.js";

/**
 * F09 (#430): `persistAllMonthlyReports`（生成済 PDF を GCS 保存 → monthly_reports 履歴 upsert する
 * オーケストレーション）をフェイク依存で単体検証する。
 *
 * 実 GCS / 実 RLS は `storage.test.ts`（path 規約 + GCS アダプタ配線）と packages/db の実 PG テストが
 * カバーするため、ここでは「保存 → INSERT の順」「決定論的 path」「校ごとに port を作る」「メトリクス
 * スナップショットの受け渡し」というオーケストレーションの不変条件のみを検証する（DB/GCS 非依存）。
 */

const SUMMARY = (month: number) =>
  ({
    year: 2026,
    month,
    totals: { view: 1, tap: 0, ask: 0 },
    ranking: [],
    activeDays: 1,
  }) as never;

function makeReport(schoolId: string, body: string): SchoolMonthlyReport {
  return {
    schoolId,
    schoolName: `${schoolId} 高校`,
    pdf: Buffer.from(body),
    metrics: { summary: SUMMARY(6), adReach: [] },
  };
}

/** save 呼び出しを記録するフェイク storage。 */
function fakeStorage(calls: { path: string; size: number }[]): ReportStoragePort {
  return {
    async save(objectPath, pdf) {
      calls.push({ path: objectPath, size: pdf.length });
    },
  };
}

/** record 呼び出しを記録し連番 id を返すフェイク persist port。 */
function fakePersistPort(recorded: ReportPersistInput[]): ReportPersistPort {
  return {
    async record(input) {
      recorded.push(input);
      return { id: `report-${recorded.length}` };
    },
  };
}

describe("persistAllMonthlyReports", () => {
  it("各校を 決定論的 path で GCS 保存し、その path で履歴を記録する", async () => {
    const saved: { path: string; size: number }[] = [];
    const recorded: ReportPersistInput[] = [];

    const result = await persistAllMonthlyReports({
      year: 2026,
      month: 6,
      reports: [makeReport("school-A", "%PDF-A"), makeReport("school-B", "%PDF-BB")],
      storage: fakeStorage(saved),
      makePersistPort: () => fakePersistPort(recorded),
    });

    // 保存 path は reports/{year}/{month2}/{schoolId}.pdf。
    expect(saved.map((s) => s.path)).toEqual([
      "reports/2026/06/school-A.pdf",
      "reports/2026/06/school-B.pdf",
    ]);
    // 履歴は保存した path・バイト数・年月で記録される。
    expect(recorded).toEqual([
      {
        schoolId: "school-A",
        year: 2026,
        month: 6,
        storagePath: "reports/2026/06/school-A.pdf",
        pdfSizeBytes: Buffer.from("%PDF-A").length,
        metricsSnapshot: { summary: SUMMARY(6), adReach: [] },
      },
      {
        schoolId: "school-B",
        year: 2026,
        month: 6,
        storagePath: "reports/2026/06/school-B.pdf",
        pdfSizeBytes: Buffer.from("%PDF-BB").length,
        metricsSnapshot: { summary: SUMMARY(6), adReach: [] },
      },
    ]);
    expect(result).toEqual({
      year: 2026,
      month: 6,
      schools: 2,
      persisted: [
        {
          schoolId: "school-A",
          storagePath: "reports/2026/06/school-A.pdf",
          pdfSizeBytes: Buffer.from("%PDF-A").length,
          reportId: "report-1",
        },
        {
          schoolId: "school-B",
          storagePath: "reports/2026/06/school-B.pdf",
          pdfSizeBytes: Buffer.from("%PDF-BB").length,
          reportId: "report-2",
        },
      ],
    });
  });

  it("保存 → INSERT の順を守る（pdf_storage_path は NOT NULL のため保存後にのみ履歴を作る）", async () => {
    const order: string[] = [];
    const storage: ReportStoragePort = {
      async save(objectPath) {
        order.push(`save:${objectPath}`);
      },
    };
    const port: ReportPersistPort = {
      async record(input) {
        order.push(`record:${input.storagePath}`);
        return { id: "r" };
      },
    };

    await persistAllMonthlyReports({
      year: 2026,
      month: 6,
      reports: [makeReport("school-A", "%PDF-A")],
      storage,
      makePersistPort: () => port,
    });

    expect(order).toEqual([
      "save:reports/2026/06/school-A.pdf",
      "record:reports/2026/06/school-A.pdf",
    ]);
  });

  it("校ごとに makePersistPort を 1 回ずつ呼ぶ（port を校間で共有しない）", async () => {
    const make = vi.fn((_schoolId: string) => fakePersistPort([]));
    await persistAllMonthlyReports({
      year: 2026,
      month: 6,
      reports: [makeReport("s1", "a"), makeReport("s2", "b"), makeReport("s3", "c")],
      storage: fakeStorage([]),
      makePersistPort: make,
    });
    expect(make).toHaveBeenCalledTimes(3);
    expect(make.mock.calls.map((c) => c[0])).toEqual(["s1", "s2", "s3"]);
  });

  it("保存が失敗した校では履歴を記録しない（fail-fast、孤児履歴行を作らない）", async () => {
    const recorded: ReportPersistInput[] = [];
    const storage: ReportStoragePort = {
      async save() {
        throw new Error("gcs down");
      },
    };

    await expect(
      persistAllMonthlyReports({
        year: 2026,
        month: 6,
        reports: [makeReport("school-A", "a")],
        storage,
        makePersistPort: () => fakePersistPort(recorded),
      }),
    ).rejects.toThrow(/gcs down/);
    expect(recorded).toHaveLength(0);
  });

  it("空の reports なら何もせず 0 集計", async () => {
    const result = await persistAllMonthlyReports({
      year: 2026,
      month: 6,
      reports: [],
      storage: fakeStorage([]),
      makePersistPort: () => fakePersistPort([]),
    });
    expect(result).toEqual({ year: 2026, month: 6, schools: 0, persisted: [] });
  });
});
