import { describe, expect, it } from "vitest";
import { DocxExtractor } from "../extractors.js";
import { buildMinimalDocx } from "./fixtures/build-fixtures.js";

/**
 * F01 **実バイト smoke E2E** (Issue #188): docx.test.ts は mammoth を vi.mock してラッパ契約のみ
 * 検証する。本ファイルは **モックせず** 実 `mammoth` を Node ランタイムで走らせ、最小の有効な
 * .docx (OOXML zip) バイトから段落テキストを実抽出できることを一度 CI で通す。
 */
describe("DocxExtractor 実バイト smoke (mammoth, モックなし)", () => {
  it("最小の実 .docx から段落テキストを抽出する", async () => {
    const bytes = buildMinimalDocx("Hello DOCX 188");

    const res = await new DocxExtractor().extract({ bytes });

    expect(res.format).toBe("docx");
    expect(res.text).toContain("Hello DOCX 188");
  });
});
