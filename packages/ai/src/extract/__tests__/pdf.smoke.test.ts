import { describe, expect, it } from "vitest";
import { PdfExtractor } from "../extractors.js";
import { buildMinimalPdf } from "./fixtures/build-fixtures.js";

/**
 * F01 **実バイト smoke E2E** (Issue #188): pdf.test.ts はパーサを vi.mock してラッパ契約のみ検証する。
 * 本ファイルは **モックせず** 実 `pdfjs-dist/legacy` build を Node ランタイムで走らせ、最小の有効な
 * PDF バイトからテキストと pageCount を実抽出できることを一度 CI で通す (legacy build の worker 無効・
 * DOM 非依存配線がランタイムで成立するかの疎通確認)。
 *
 * 注: pdfjs が stderr に出す `standardFontDataUrl` 警告は**想定内・無害**。標準フォント(Helvetica)の
 * グリフ描画用データの所在で、`getTextContent()` のテキスト抽出には不要 (本テストは text を正しく取得する)。
 * standardFontDataUrl を設定するにはバンドル後 (Cloud Run / Turbopack) でも standard_fonts を解決できる
 * 配線が要り、誤設定はかえって本番を壊しうるため、本 test-only PR のスコープ外とする。
 */
describe("PdfExtractor 実バイト smoke (pdfjs-dist legacy, モックなし)", () => {
  it("最小の実 PDF からテキストと meta.pageCount=1 を抽出する", async () => {
    const bytes = buildMinimalPdf("Hello PDF 188");

    const res = await new PdfExtractor().extract({ bytes });

    expect(res.format).toBe("pdf");
    expect(res.text).toContain("Hello PDF 188");
    expect(res.meta?.pageCount).toBe(1);
  });

  it("呼び出し側の bytes を破壊しない (pdfjs は内部で TypedArray を detach するためコピーを渡す)", async () => {
    const bytes = buildMinimalPdf("Roundtrip 188");
    const before = bytes.byteLength;

    await new PdfExtractor().extract({ bytes });

    // 抽出後も元の bytes は detach されず長さを保つ (extractors.ts のコピー渡しを実バイトで実証)。
    expect(bytes.byteLength).toBe(before);
  });
});
