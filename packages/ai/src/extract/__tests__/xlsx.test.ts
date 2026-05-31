import { Workbook as ExceljsWorkbook } from "exceljs";
import { describe, expect, it } from "vitest";
import { XlsxExtractor } from "../extractors.js";
import { ExtractFailedError } from "../types.js";

/**
 * xlsx は exceljs で in-test にワークブックを書き出し、その実バイトを XlsxExtractor で読む
 * round-trip 実 E2E テスト（fixture バイナリを持ち込まないので脆くならない）。
 */

/** exceljs でワークブックを組み、Buffer として書き出す。 */
async function buildWorkbook(
  sheets: ReadonlyArray<{ name: string; rows: ReadonlyArray<ReadonlyArray<string | number>> }>,
): Promise<Uint8Array> {
  const wb = new ExceljsWorkbook();
  for (const { name, rows } of sheets) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) {
      ws.addRow([...row]);
    }
  }
  const ab = await wb.xlsx.writeBuffer();
  return new Uint8Array(ab as ArrayBuffer);
}

describe("XlsxExtractor (round-trip 実 E2E)", () => {
  it("シート名とセル値が text に現れ、meta.sheetNames を埋める", async () => {
    const bytes = await buildWorkbook([
      {
        name: "予定",
        rows: [
          ["日付", "内容"],
          ["6/1", "始業式"],
        ],
      },
      { name: "連絡", rows: [["保護者会は来週"]] },
    ]);

    const res = await new XlsxExtractor().extract({ bytes });

    expect(res.format).toBe("xlsx");
    expect(res.meta?.sheetNames).toEqual(["予定", "連絡"]);
    // セル値が抽出テキストに含まれる。
    expect(res.text).toContain("始業式");
    expect(res.text).toContain("保護者会は来週");
    // シート見出しが入る。
    expect(res.text).toContain("# 予定");
    expect(res.text).toContain("# 連絡");
    // 行内のセルはタブ区切り。
    expect(res.text).toContain("日付\t内容");
  });

  it("数値セルも文字列化される", async () => {
    const bytes = await buildWorkbook([{ name: "S1", rows: [["人数", 42]] }]);
    const res = await new XlsxExtractor().extract({ bytes });
    expect(res.text).toContain("42");
  });

  it("壊れたバイト列は ExtractFailedError にラップして投げる（フェイルクローズ）", async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    const promise = new XlsxExtractor().extract({ bytes: garbage });
    await expect(promise).rejects.toBeInstanceOf(ExtractFailedError);
    await expect(promise).rejects.toMatchObject({ format: "xlsx", dependency: "exceljs" });
  });
});
