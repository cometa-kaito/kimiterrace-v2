import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocxExtractor } from "../extractors.js";
import { ExtractFailedError } from "../types.js";

/**
 * docx はバイナリ fixture が脆いため、`mammoth` をモックして **抽出器ラッパの契約** を検証する:
 *  (a) バイト列を Buffer として extractRawText に渡している
 *  (b) パーサの { value } を ExtractedText(text) に正しくマップしている
 *  (c) パーサ例外を ExtractFailedError にラップして再 throw（フェイルクローズ）
 * mammoth 自体の docx 解析能力は再テストしない（それはライブラリの責務）。
 */

const extractRawText = vi.fn();

// mammoth は CJS (`export =`)。extractors.ts は (await import).default を取るので default を生やす。
vi.mock("mammoth", () => ({
  default: { extractRawText: (...args: unknown[]) => extractRawText(...args) },
}));

beforeEach(() => {
  extractRawText.mockReset();
});

describe("DocxExtractor (mammoth モック)", () => {
  it("(a) バイト列を Buffer として渡す / (b) value を text にマップする", async () => {
    extractRawText.mockResolvedValue({ value: "見出し\n本文の段落", messages: [] });

    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP magic 風
    const res = await new DocxExtractor().extract({ bytes });

    // (a) extractRawText に { buffer: Buffer } を渡し、Buffer 内容がバイト列と一致。
    expect(extractRawText).toHaveBeenCalledTimes(1);
    const arg = extractRawText.mock.calls[0]?.[0] as { buffer: Buffer };
    expect(Buffer.isBuffer(arg.buffer)).toBe(true);
    expect(Array.from(arg.buffer)).toEqual([0x50, 0x4b, 0x03, 0x04]);

    // (b) value → text。
    expect(res.format).toBe("docx");
    expect(res.text).toBe("見出し\n本文の段落");
  });

  it("(c) パーサ例外を ExtractFailedError にラップして再 throw する", async () => {
    extractRawText.mockRejectedValue(new Error("not a valid zip / docx"));

    const promise = new DocxExtractor().extract({ bytes: new Uint8Array([0]) });
    await expect(promise).rejects.toBeInstanceOf(ExtractFailedError);
    await expect(promise).rejects.toMatchObject({ format: "docx", dependency: "mammoth" });
    await promise.catch((err: unknown) => {
      expect((err as ExtractFailedError).cause).toBeInstanceOf(Error);
      expect((err as ExtractFailedError).message).toContain("not a valid zip");
    });
  });
});
