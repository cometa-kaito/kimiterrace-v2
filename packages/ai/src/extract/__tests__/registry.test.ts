import { describe, expect, it } from "vitest";
import {
  DocxExtractor,
  ImageExtractor,
  PdfExtractor,
  TextExtractor,
  XlsxExtractor,
} from "../extractors.js";
import { ExtractorRegistry, createDefaultRegistry, extractText } from "../registry.js";
import {
  type DocumentExtractor,
  type ExtractSource,
  type ExtractedText,
  ExtractorNotConfiguredError,
  UnsupportedFormatError,
} from "../types.js";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("TextExtractor", () => {
  it("UTF-8 バイト列をそのままデコードする", async () => {
    const res = await new TextExtractor().extract({ bytes: bytesOf("こんにちは、田中です") });
    expect(res).toEqual<ExtractedText>({ text: "こんにちは、田中です", format: "text" });
  });

  it("不正バイトは置換文字に倒して全体を失わない", async () => {
    const res = await new TextExtractor().extract({ bytes: new Uint8Array([0xff, 0x41]) });
    expect(res.text).toContain("A");
  });
});

describe("未配線スタブはフェイルクローズで投げる", () => {
  it.each([
    [new PdfExtractor(), "pdf", "pdfjs-dist"],
    [new DocxExtractor(), "docx", "mammoth"],
    [new XlsxExtractor(), "xlsx", "exceljs"],
    [new ImageExtractor(), "image", "@google-cloud/vision"],
  ] as const)("%s は ExtractorNotConfiguredError（依存名付き）", async (extractor, format, dep) => {
    const promise = extractor.extract({ bytes: new Uint8Array() });
    await expect(promise).rejects.toBeInstanceOf(ExtractorNotConfiguredError);
    await expect(promise).rejects.toMatchObject({ format, dependency: dep });
  });
});

describe("ExtractorRegistry", () => {
  it("形式を推定し対応する抽出器に委譲する", async () => {
    const reg = createDefaultRegistry();
    const res = await reg.extract({ bytes: bytesOf("予定表"), mimeType: "text/plain" });
    expect(res.format).toBe("text");
    expect(res.text).toBe("予定表");
  });

  it("未登録形式は UnsupportedFormatError", async () => {
    const reg = new ExtractorRegistry().register(new TextExtractor());
    await expect(reg.extract({ bytes: new Uint8Array(), format: "pdf" })).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });

  it("register は同一形式を後勝ちで上書きする", async () => {
    const fake: DocumentExtractor = {
      format: "text",
      supports: (f) => f === "text",
      async extract(_s: ExtractSource): Promise<ExtractedText> {
        return { text: "FAKE", format: "text" };
      },
    };
    const reg = new ExtractorRegistry().register(new TextExtractor()).register(fake);
    const res = await reg.extract({ bytes: bytesOf("ignored"), format: "text" });
    expect(res.text).toBe("FAKE");
  });

  it("get は登録済み抽出器を返し、未登録は undefined", () => {
    const reg = new ExtractorRegistry().register(new TextExtractor());
    expect(reg.get("text")).toBeInstanceOf(TextExtractor);
    expect(reg.get("pdf")).toBeUndefined();
  });
});

describe("extractText 便宜関数", () => {
  it("既定レジストリで text を素通しする", async () => {
    const res = await extractText({ bytes: bytesOf("メモ"), filename: "memo.txt" });
    expect(res).toEqual<ExtractedText>({ text: "メモ", format: "text" });
  });

  it("未配線形式は ExtractorNotConfiguredError まで伝播する", async () => {
    await expect(
      extractText({ bytes: new Uint8Array(), filename: "a.pdf" }),
    ).rejects.toBeInstanceOf(ExtractorNotConfiguredError);
  });
});
