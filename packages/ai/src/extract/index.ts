// F01 テキスト抽出レイヤの公開 API（extract サブパッケージのバレル）。
// 注: パッケージ全体のバレル（packages/ai/src/index.ts）への再エクスポート追加は別 PR で行う。

export { detectFormat } from "./detect.js";
export {
  assertStandardFontsAvailable,
  DocxExtractor,
  ImageExtractor,
  PdfExtractor,
  TextExtractor,
  XlsxExtractor,
} from "./extractors.js";
export { ExtractorRegistry, createDefaultRegistry, extractText } from "./registry.js";
export type { RegistryOptions } from "./registry.js";
export { createVisionOcrClient } from "./ocr/vision.js";
export type { VisionOcrConfig } from "./ocr/vision.js";
// ADR-038: 画像 OCR を Gemini マルチモーダル直送（asia-northeast1）に切替（ADR-024 決定2 を supersede）。
export { createGeminiOcrClient } from "./ocr/gemini.js";
export type { GeminiOcrConfig } from "./ocr/gemini.js";
export {
  SOURCE_FORMATS,
  UnsupportedFormatError,
  LegacyOfficeFormatError,
  ExtractorNotConfiguredError,
  ExtractFailedError,
} from "./types.js";
export type {
  SourceFormat,
  ExtractSource,
  ExtractMeta,
  ExtractedText,
  DocumentExtractor,
  OcrClient,
  OcrResult,
} from "./types.js";
