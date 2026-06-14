import { describe, expect, it, vi } from "vitest";
import { ImageExtractor } from "../extractors.js";
import { createDefaultRegistry, extractText } from "../registry.js";
import {
  ExtractFailedError,
  type ExtractedText,
  ExtractorNotConfiguredError,
  type OcrClient,
} from "../types.js";

const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // 適当な画像バイト列（PNG マジック）

/** スクリプト化したフェイク OCR。受け取った bytes / mediaType を記録し、用意した結果を返す。 */
function fakeOcr(result: { text: string; confidence?: number }): OcrClient & {
  calls: Uint8Array[];
  mediaTypes: (string | undefined)[];
} {
  const calls: Uint8Array[] = [];
  const mediaTypes: (string | undefined)[] = [];
  return {
    calls,
    mediaTypes,
    async recognize(bytes: Uint8Array, mediaType?: string) {
      calls.push(bytes);
      mediaTypes.push(mediaType);
      return result;
    },
  };
}

describe("ImageExtractor", () => {
  it("OcrClient 未注入ならフェイルクローズ（ExtractorNotConfiguredError）", async () => {
    const promise = new ImageExtractor().extract({ bytes: IMG });
    await expect(promise).rejects.toBeInstanceOf(ExtractorNotConfiguredError);
    await expect(promise).rejects.toMatchObject({
      format: "image",
      dependency: "@google-cloud/vision",
    });
  });

  it("注入された OcrClient でテキスト化し ocrUsed/confidence を立てる", async () => {
    const ocr = fakeOcr({ text: "時間割 1限 国語", confidence: 0.92 });
    const res = await new ImageExtractor(ocr).extract({ bytes: IMG });
    expect(res).toEqual<ExtractedText>({
      text: "時間割 1限 国語",
      format: "image",
      meta: { ocrUsed: true, confidence: 0.92 },
    });
    // 元の画像バイト列をそのまま OCR に渡している。
    expect(ocr.calls).toHaveLength(1);
    expect(ocr.calls[0]).toBe(IMG);
  });

  it("source.mimeType を OCR の mediaType ヒントへ渡す（Gemini 画像パート用・ADR-038）", async () => {
    const ocr = fakeOcr({ text: "x" });
    await new ImageExtractor(ocr).extract({ bytes: IMG, mimeType: "image/jpeg" });
    expect(ocr.mediaTypes).toEqual(["image/jpeg"]);
  });

  it("confidence を出さない OcrClient でも ocrUsed は true", async () => {
    const res = await new ImageExtractor(fakeOcr({ text: "メモ" })).extract({ bytes: IMG });
    expect(res.meta).toEqual({ ocrUsed: true, confidence: undefined });
  });

  it("OCR 例外は握りつぶさず ExtractFailedError(cause 付き)にラップ", async () => {
    const boom = new Error("vision unavailable");
    const ocr: OcrClient = {
      recognize: vi.fn().mockRejectedValue(boom),
    };
    const promise = new ImageExtractor(ocr).extract({ bytes: IMG });
    await expect(promise).rejects.toBeInstanceOf(ExtractFailedError);
    await expect(promise).rejects.toMatchObject({ format: "image", cause: boom });
  });
});

describe("registry の OCR 配線", () => {
  it("createDefaultRegistry({ ocr }) は image を OCR にルーティングする", async () => {
    const reg = createDefaultRegistry({ ocr: fakeOcr({ text: "掲示" }) });
    const res = await reg.extract({ bytes: IMG, mimeType: "image/png" });
    expect(res.format).toBe("image");
    expect(res.text).toBe("掲示");
    expect(res.meta?.ocrUsed).toBe(true);
  });

  it("createDefaultRegistry()（ocr 未指定）では image は ExtractorNotConfiguredError のまま", async () => {
    const reg = createDefaultRegistry();
    await expect(reg.extract({ bytes: IMG, format: "image" })).rejects.toBeInstanceOf(
      ExtractorNotConfiguredError,
    );
  });

  it("extractText(source, { ocr }) でも OCR が使える", async () => {
    const res = await extractText(
      { bytes: IMG, filename: "board.png" },
      { ocr: fakeOcr({ text: "OK" }) },
    );
    expect(res).toMatchObject({ text: "OK", format: "image", meta: { ocrUsed: true } });
  });
});
