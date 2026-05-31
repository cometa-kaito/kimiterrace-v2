import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfExtractor } from "../extractors.js";
import { ExtractFailedError } from "../types.js";

/**
 * pdf はバイナリ fixture が脆いため、`pdfjs-dist` をモックして **抽出器ラッパの契約** を検証する:
 *  (a) バイト列をパーサ (getDocument) に渡している
 *  (b) ページごとの getTextContent 結果を ExtractedText(text + meta.pageCount) に正しくマップ
 *  (c) パーサ例外を ExtractFailedError にラップして再 throw（フェイルクローズ）
 * ライブラリ自体の PDF 解析能力は再テストしない（それはライブラリの責務）。
 */

const getDocument = vi.fn();

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: (...args: unknown[]) => getDocument(...args),
}));

/** items 配列を持つ簡易ページ proxy を作る。 */
function fakePage(items: Array<{ str: string } | Record<string, never>>) {
  return {
    getTextContent: vi.fn().mockResolvedValue({ items }),
    cleanup: vi.fn(),
  };
}

/** numPages / getPage / destroy を持つ簡易 document proxy を作る。 */
function fakeDocument(pages: ReturnType<typeof fakePage>[]) {
  return {
    numPages: pages.length,
    getPage: vi.fn((n: number) => Promise.resolve(pages[n - 1])),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  getDocument.mockReset();
});

describe("PdfExtractor (pdfjs-dist モック)", () => {
  it("(a) バイト列をパーサに渡す / (b) ページテキストと pageCount をマップする", async () => {
    const doc = fakeDocument([
      fakePage([{ str: "1ページ目" }, { str: "の本文" }]),
      fakePage([{ str: "2ページ目" }]),
    ]);
    getDocument.mockReturnValue({ promise: Promise.resolve(doc) });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const res = await new PdfExtractor().extract({ bytes });

    // (a) getDocument に { data: <bytes と同内容> } を渡している。
    expect(getDocument).toHaveBeenCalledTimes(1);
    const arg = getDocument.mock.calls[0]?.[0] as { data: Uint8Array };
    expect(Array.from(arg.data)).toEqual([1, 2, 3, 4]);

    // (b) ページ結合 + meta.pageCount。
    expect(res.format).toBe("pdf");
    expect(res.text).toBe("1ページ目の本文\n2ページ目");
    expect(res.meta?.pageCount).toBe(2);
  });

  it("(b) TextMarkedContent（str を持たない item）は無視する", async () => {
    const doc = fakeDocument([fakePage([{ str: "本文" }, {}, { str: "続き" }])]);
    getDocument.mockReturnValue({ promise: Promise.resolve(doc) });

    const res = await new PdfExtractor().extract({ bytes: new Uint8Array([0]) });
    expect(res.text).toBe("本文続き");
  });

  it("(c) パーサ例外を ExtractFailedError にラップして再 throw する", async () => {
    // promise getter にして、抽出器が await した瞬間に初めて reject を生成する
    // （eager な Promise.reject は await 前に unhandled rejection 扱いされるため）。
    getDocument.mockReturnValue({
      get promise() {
        return Promise.reject(new Error("Invalid PDF structure"));
      },
    });

    const promise = new PdfExtractor().extract({ bytes: new Uint8Array([9]) });
    await expect(promise).rejects.toBeInstanceOf(ExtractFailedError);
    await expect(promise).rejects.toMatchObject({ format: "pdf", dependency: "pdfjs-dist" });
    // 元例外を cause に保持する。
    await promise.catch((err: unknown) => {
      expect((err as ExtractFailedError).cause).toBeInstanceOf(Error);
      expect((err as ExtractFailedError).message).toContain("Invalid PDF structure");
    });
  });
});
