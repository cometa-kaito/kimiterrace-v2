import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfExtractor } from "../extractors.js";
import { ExtractFailedError, type OcrClient } from "../types.js";

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

/** numPages / getPage を持つ簡易 document proxy を作る（v6: PDFDocumentProxy.destroy は削除済み）。 */
function fakeDocument(pages: ReturnType<typeof fakePage>[]) {
  return {
    numPages: pages.length,
    getPage: vi.fn((n: number) => Promise.resolve(pages[n - 1])),
  };
}

/**
 * v6 の PDFDocumentLoadingTask を模した戻り値。`promise` で document に解決し、
 * クリーンアップは `destroy()`（v5 の doc.destroy から移管）で行う。
 */
function fakeLoadingTask(doc: ReturnType<typeof fakeDocument>) {
  return {
    promise: Promise.resolve(doc),
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
    getDocument.mockReturnValue(fakeLoadingTask(doc));

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
    getDocument.mockReturnValue(fakeLoadingTask(doc));

    const res = await new PdfExtractor().extract({ bytes: new Uint8Array([0]) });
    expect(res.text).toBe("本文続き");
  });

  it("(c) パーサ例外を ExtractFailedError にラップして再 throw する（dependency=pdfjs-dist）", async () => {
    // promise getter にして、抽出器が await した瞬間に初めて reject を生成する
    // （eager な Promise.reject は await 前に unhandled rejection 扱いされるため）。
    // promise reject 後も finally で loadingTask.destroy() が呼ばれるため destroy を備える
    // （destroy 不在だと finally の TypeError が元 cause を覆い隠す）。
    getDocument.mockReturnValue({
      get promise() {
        return Promise.reject(new Error("Invalid PDF structure"));
      },
      destroy: vi.fn().mockResolvedValue(undefined),
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

/** 呼び出し引数を記録するフェイク OcrClient。 */
function fakeOcr(result: { text: string; confidence?: number }) {
  const calls: Array<{ bytes: Uint8Array; mediaType?: string }> = [];
  const client: OcrClient = {
    recognize(bytes, mediaType) {
      calls.push({ bytes, mediaType });
      return Promise.resolve(result);
    },
  };
  return { client, calls };
}

describe("PdfExtractor: スキャン PDF の OCR フォールバック (ADR-038)", () => {
  it("テキストレイヤが希薄なら注入 OCR に application/pdf で直送し、テキスト+ocrUsed/pageCount を返す", async () => {
    // 2 ページとも text layer 空（スキャン PDF を模す）。
    const doc = fakeDocument([fakePage([]), fakePage([{}])]);
    getDocument.mockReturnValue(fakeLoadingTask(doc));
    const ocr = fakeOcr({ text: "1限 国語\n2限 数学", confidence: 0.9 });

    const bytes = new Uint8Array([5, 6, 7]);
    const res = await new PdfExtractor(ocr.client).extract({ bytes });

    expect(res.text).toBe("1限 国語\n2限 数学");
    expect(res.meta).toEqual({ pageCount: 2, ocrUsed: true, confidence: 0.9 });
    // OCR には元 PDF バイトと application/pdf を渡す（Gemini ネイティブ PDF 直送）。
    expect(ocr.calls).toHaveLength(1);
    expect(ocr.calls[0]?.mediaType).toBe("application/pdf");
    expect(Array.from(ocr.calls[0]?.bytes ?? [])).toEqual([5, 6, 7]);
  });

  it("テキストレイヤが十分なら OCR を呼ばずテキストレイヤを返す（egress なし）", async () => {
    const rich = "今日の連絡です。明日は遠足のため弁当を持参してください。集合は8時。".repeat(2);
    const doc = fakeDocument([fakePage([{ str: rich }])]);
    getDocument.mockReturnValue(fakeLoadingTask(doc));
    const ocr = fakeOcr({ text: "使わない" });

    const res = await new PdfExtractor(ocr.client).extract({ bytes: new Uint8Array([1]) });

    expect(res.text).toBe(rich);
    expect(res.meta?.ocrUsed).toBeUndefined();
    expect(ocr.calls).toHaveLength(0);
  });

  it("OCR 未注入ならテキストレイヤが希薄でもそのまま返す（フォールバックしない・throw しない）", async () => {
    const doc = fakeDocument([fakePage([])]);
    getDocument.mockReturnValue(fakeLoadingTask(doc));

    const res = await new PdfExtractor().extract({ bytes: new Uint8Array([0]) });

    expect(res.text).toBe("");
    expect(res.meta).toEqual({ pageCount: 1 });
  });

  it("OCR フォールバック失敗は dependency=gemini-ocr の ExtractFailedError（pdfjs と区別）", async () => {
    const doc = fakeDocument([fakePage([])]);
    getDocument.mockReturnValue(fakeLoadingTask(doc));
    const failing: OcrClient = { recognize: () => Promise.reject(new Error("vertex down")) };

    const promise = new PdfExtractor(failing).extract({ bytes: new Uint8Array([0]) });
    await expect(promise).rejects.toBeInstanceOf(ExtractFailedError);
    await expect(promise).rejects.toMatchObject({ format: "pdf", dependency: "gemini-ocr" });
  });
});
