// F01 テキスト抽出レイヤの公開 API（extract サブパッケージのバレル）。
// 注: パッケージ全体のバレル（packages/ai/src/index.ts）への再エクスポート追加は別 PR で行う。

export { detectFormat } from "./detect.js";
export {
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
