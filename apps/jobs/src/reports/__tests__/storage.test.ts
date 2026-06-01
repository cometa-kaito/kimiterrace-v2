import { describe, expect, it, vi } from "vitest";
import { buildReportObjectPath, createGcsReportStorage } from "../storage.js";

/**
 * F09 (#430): 保存 path 規約 `buildReportObjectPath` と GCS アダプタ `createGcsReportStorage` の
 * ユニットテスト。GCS への実保存は注入したフェイク Storage で配線を pin する（GCP 認証不要、ADR-012）。
 */

describe("buildReportObjectPath", () => {
  it("reports/{year}/{month2}/{schoolId}.pdf を返す（月はゼロ詰め 2 桁）", () => {
    expect(buildReportObjectPath("school-A", 2026, 6)).toBe("reports/2026/06/school-A.pdf");
    expect(buildReportObjectPath("school-A", 2026, 12)).toBe("reports/2026/12/school-A.pdf");
  });

  it("決定論的: 同一 (校, 年, 月) は常に同じ path（再実行で同 path を上書き = 冪等）", () => {
    expect(buildReportObjectPath("s1", 2026, 3)).toBe(buildReportObjectPath("s1", 2026, 3));
  });

  it("month が 1-12 外なら RangeError（壊れた path で保存しない）", () => {
    expect(() => buildReportObjectPath("s1", 2026, 0)).toThrow(RangeError);
    expect(() => buildReportObjectPath("s1", 2026, 13)).toThrow(RangeError);
  });

  it("year が非整数 / schoolId が空なら RangeError", () => {
    expect(() => buildReportObjectPath("s1", 2026.5, 6)).toThrow(RangeError);
    expect(() => buildReportObjectPath("", 2026, 6)).toThrow(RangeError);
  });
});

describe("createGcsReportStorage", () => {
  it("bucket が空なら throw（env REPORT_BUCKET 未設定を弾く）", () => {
    expect(() => createGcsReportStorage({ bucket: "" })).toThrow(/bucket/);
  });

  it("save: 指定 path の file へ application/pdf で保存する", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const file = vi.fn(() => ({ save }));
    const bucket = vi.fn(() => ({ file }));
    // @google-cloud/storage の最小サーフェスだけを満たすフェイク。
    const fakeStorage = { bucket } as never;

    const storage = createGcsReportStorage({ bucket: "kt-reports", storage: fakeStorage });
    const pdf = Buffer.from("%PDF-1.7 fake");
    await storage.save("reports/2026/06/school-A.pdf", pdf);

    expect(bucket).toHaveBeenCalledWith("kt-reports");
    expect(file).toHaveBeenCalledWith("reports/2026/06/school-A.pdf");
    expect(save).toHaveBeenCalledTimes(1);
    const [savedBuf, opts] = save.mock.calls.at(0) ?? [];
    expect(savedBuf).toBe(pdf);
    expect(opts).toMatchObject({ contentType: "application/pdf", resumable: false });
  });
});
