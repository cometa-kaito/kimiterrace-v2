// F03 AI 構造化パッケージの公開 API。

// PII マスキング（CLAUDE.md ルール4）
export { maskPII, unmaskPII, unmaskDeep, findUnmaskedPii } from "./pii/mask.js";
export type { MaskResult, MaskOptions, PiiCategory, PiiEntry } from "./pii/types.js";

// 構造化出力スキーマ（ADR-017）
export {
  EXTRACTION_KINDS,
  extractionSchema,
  evidenceItemSchema,
  schemaForKind,
} from "./schema/extraction.js";
export type { Extraction, ExtractionKind, EvidenceItem } from "./schema/extraction.js";

// プロンプト構築（インジェクション対策）
export {
  buildSystemPrompt,
  buildUserPrompt,
  neutralizeInput,
  repairHint,
} from "./prompt/build.js";

// モデル境界 + Vertex アダプタ（ADR-005/006）
export type { ModelClient, ModelRequest, ModelResponse, ModelUsage } from "./model/client.js";
export { createVertexModelClient } from "./model/vertex.js";
export type { VertexModelConfig } from "./model/vertex.js";

// レート制限（NFR06）
export {
  FixedWindowRateLimiter,
  createPerSchoolRateLimiter,
} from "./rate-limit.js";
export type { RateLimiter } from "./rate-limit.js";

// オーケストレータ
export { structureContent, RateLimitExceededError, PiiLeakError } from "./structure.js";
export type { StructureRequest, StructureResult } from "./structure.js";

// 監査マッパー
export { toAiExtractionInsert } from "./audit.js";
export type { AiExtractionInsert, AuditMapParams } from "./audit.js";

// F01 テキスト抽出レイヤ（PDF/Word/Excel/画像 → 素テキスト → structureContent 前段、#180）
export {
  detectFormat,
  ExtractorRegistry,
  createDefaultRegistry,
  extractText,
  TextExtractor,
  PdfExtractor,
  DocxExtractor,
  XlsxExtractor,
  ImageExtractor,
  SOURCE_FORMATS,
  UnsupportedFormatError,
  ExtractorNotConfiguredError,
} from "./extract/index.js";
export type {
  SourceFormat,
  ExtractSource,
  ExtractMeta,
  ExtractedText,
  DocumentExtractor,
} from "./extract/index.js";
