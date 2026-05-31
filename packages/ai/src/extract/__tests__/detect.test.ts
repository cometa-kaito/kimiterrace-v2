import { describe, expect, it } from "vitest";
import { detectFormat } from "../detect.js";
import { LegacyOfficeFormatError, UnsupportedFormatError } from "../types.js";

const EMPTY = new Uint8Array();

describe("detectFormat", () => {
  it("明示 format を最優先する（推定をスキップ）", () => {
    expect(detectFormat({ bytes: EMPTY, format: "pdf", filename: "a.txt" })).toBe("pdf");
  });

  it("mimeType を filename より優先する", () => {
    const fmt = detectFormat({
      bytes: EMPTY,
      mimeType: "application/pdf",
      filename: "report.txt",
    });
    expect(fmt).toBe("pdf");
  });

  it.each([
    ["application/pdf", "pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
    ["text/plain", "text"],
    ["text/csv", "text"],
    ["image/png", "image"],
    ["image/jpeg", "image"],
  ] as const)("mimeType %s → %s", (mimeType, expected) => {
    expect(detectFormat({ bytes: EMPTY, mimeType })).toBe(expected);
  });

  it("image/* の未知 subtype も image とみなす", () => {
    expect(detectFormat({ bytes: EMPTY, mimeType: "image/heic" })).toBe("image");
  });

  it("mimeType の charset パラメータを無視する", () => {
    expect(detectFormat({ bytes: EMPTY, mimeType: "text/plain; charset=utf-8" })).toBe("text");
  });

  it.each([
    ["a.pdf", "pdf"],
    ["a.docx", "docx"],
    ["a.xlsx", "xlsx"],
    ["a.txt", "text"],
    ["a.md", "text"],
    ["notes.CSV", "text"],
    ["photo.JPG", "image"],
    ["scan.tiff", "image"],
  ] as const)("filename %s → %s（大小無視）", (filename, expected) => {
    expect(detectFormat({ bytes: EMPTY, filename })).toBe(expected);
  });

  it("未知 mimeType でも filename にフォールバックする", () => {
    expect(
      detectFormat({ bytes: EMPTY, mimeType: "application/octet-stream", filename: "a.pdf" }),
    ).toBe("pdf");
  });

  it("推定不能なら UnsupportedFormatError", () => {
    expect(() => detectFormat({ bytes: EMPTY })).toThrow(UnsupportedFormatError);
    expect(() => detectFormat({ bytes: EMPTY, filename: "noext" })).toThrow(UnsupportedFormatError);
    expect(() => detectFormat({ bytes: EMPTY, filename: "trailingdot." })).toThrow(
      UnsupportedFormatError,
    );
    expect(() => detectFormat({ bytes: EMPTY, mimeType: "application/zip" })).toThrow(
      UnsupportedFormatError,
    );
  });
});

describe("detectFormat: レガシー Office (.doc/.xls)", () => {
  it.each([
    ["application/msword", "doc", "docx"],
    ["application/vnd.ms-excel", "xls", "xlsx"],
  ] as const)("レガシー MIME %s は LegacyOfficeFormatError（→ %s）", (mimeType, legacyExt, suggested) => {
    try {
      detectFormat({ bytes: EMPTY, mimeType });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LegacyOfficeFormatError);
      expect(e).toMatchObject({ legacyExt, suggested });
    }
  });

  it.each([
    ["legacy.doc", "doc", "docx"],
    ["template.dot", "dot", "docx"],
    ["sheet.XLS", "xls", "xlsx"],
    ["book.xlt", "xlt", "xlsx"],
  ] as const)("レガシー拡張子 %s は LegacyOfficeFormatError（→ %s）", (filename, legacyExt, suggested) => {
    try {
      detectFormat({ bytes: EMPTY, filename });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LegacyOfficeFormatError);
      expect(e).toMatchObject({ legacyExt, suggested });
    }
  });

  it("LegacyOfficeFormatError は UnsupportedFormatError の派生（既存 catch でも拾える）", () => {
    expect(() => detectFormat({ bytes: EMPTY, mimeType: "application/msword" })).toThrow(
      UnsupportedFormatError,
    );
  });

  it("変換を促すメッセージに変換先拡張子を含む", () => {
    try {
      detectFormat({ bytes: EMPTY, filename: "old.doc" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("docx");
    }
  });

  it("OOXML(.docx/.xlsx) は通常どおり判定され throw しない", () => {
    expect(detectFormat({ bytes: EMPTY, filename: "modern.docx" })).toBe("docx");
    expect(detectFormat({ bytes: EMPTY, filename: "modern.xlsx" })).toBe("xlsx");
  });
});
