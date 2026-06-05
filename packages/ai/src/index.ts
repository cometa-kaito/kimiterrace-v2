// F03 AI 構造化パッケージの公開 API。

// 実 Vertex の kill-switch（AI_ENABLED 既定 OFF、ルール4 / ADR-030、#289 / #593）。
// apps/web・apps/jobs の両 Vertex 入口がこれを参照する単一ソース。
export { isAiEnabled, assertAiEnabled, AiDisabledError } from "./ai-enabled.js";

// PII マスキング（CLAUDE.md ルール4）
export { maskPII, unmaskPII, unmaskDeep, findUnmaskedPii } from "./pii/mask.js";
export type { MaskResult, MaskOptions, PiiCategory, PiiEntry } from "./pii/types.js";
// 掲示物 authoring 時のロスター無し PII (生徒/保護者氏名) soft-gate 検出 (#426, ADR-030)
export {
  findSuspectedPersonalNames,
  hasSuspectedPersonalName,
  HONORIFICS,
  EXCLUDED_BASE,
} from "./pii/name-heuristic.js";
export type { SuspectedName } from "./pii/name-heuristic.js";

// 構造化出力スキーマ（ADR-017）
export {
  EXTRACTION_KINDS,
  extractionSchema,
  evidenceItemSchema,
  schemaForKind,
  // F01 (2026-06-03): 教員 UI の既定値提案（公開先・掲示期間、optional）
  SUGGESTED_PUBLISH_SCOPES,
  suggestedPeriodSchema,
} from "./schema/extraction.js";
export type {
  Extraction,
  ExtractionKind,
  EvidenceItem,
  SuggestedPublishScope,
  SuggestedPeriod,
} from "./schema/extraction.js";

// プロンプト構築（インジェクション対策）
export {
  buildSystemPrompt,
  buildUserPrompt,
  neutralizeInput,
  repairHint,
} from "./prompt/build.js";

// F06 (#368, ADR-028) 生徒対話 Q&A プロンプト builder + 補足ガードレール
export {
  buildChatPrompt,
  buildChatSystemPrompt,
  buildContextBlock,
  buildQuestionBlock,
} from "./prompt/chat.js";
export type { ChatContext, ChatPrompt, GroundingMode } from "./prompt/chat.js";

// F08 (#44, ADR-005) AI 効果コメント生成プロンプト builder（決定論的・PII マスク前提、slice 1）
export {
  buildEffectCommentPrompt,
  buildEffectCommentSystemPrompt,
  buildStatsBlock,
  formatDelta,
} from "./prompt/effect-comment.js";
export type {
  EffectCommentPrompt,
  EffectCommentStats,
  EffectMetric,
  EffectTopContent,
} from "./prompt/effect-comment.js";

// F08 (#44, ADR-005/006) 効果コメントのモデル呼び出し層（builder → 実 Gemini, slice 2: 非 JSON テキスト）
export {
  EmptyEffectCommentError,
  createVertexEffectCommentClient,
  generateEffectComment,
} from "./model/effect-comment-model.js";
export type {
  EffectCommentModelConfig,
  EffectCommentResult,
} from "./model/effect-comment-model.js";

// モデル境界 + Vertex アダプタ（ADR-005/006）
export type { ModelClient, ModelRequest, ModelResponse, ModelUsage } from "./model/client.js";
export { createVertexModelClient } from "./model/vertex.js";
export type { VertexModelConfig } from "./model/vertex.js";

// F06 (#373, ADR-005/006) 生徒対話 SSE の Vertex ストリーミングクライアント（streamText 逐次）
export { createVertexChatStreamClient } from "./model/chat-stream.js";
export type {
  VertexChatStreamClient,
  VertexChatStreamConfig,
  ChatStreamResult,
} from "./model/chat-stream.js";

// F06 (#365, ADR-007) Vertex テキスト embedding アダプタ（RAG: コンテンツ/質問の embedding 生成、768 次元）
export { EMBEDDING_DIM, EmbeddingError, createVertexEmbeddingClient } from "./model/embed.js";
export type { EmbeddingClient, VertexEmbeddingConfig } from "./model/embed.js";

// レート制限（NFR06）
export {
  FixedWindowRateLimiter,
  createPerSchoolRateLimiter,
} from "./rate-limit.js";
export type { RateLimiter } from "./rate-limit.js";

// 分散レート制限（ADR-027、#155）: 複数 Cloud Run インスタンスを跨ぐ共有ストア版。
// 実ストア（PostgresRateLimitStore）は follow-up PR (#155-B) で packages/db に追加。
export {
  DistributedRateLimiter,
  createPerSchoolDistributedRateLimiter,
} from "./rate-limit-distributed.js";
export type { RateLimitStore } from "./rate-limit-distributed.js";

// オーケストレータ
export { structureContent, RateLimitExceededError, PiiLeakError } from "./structure.js";
export type { StructureRequest, StructureResult } from "./structure.js";

// F06 スコープ分類器 (ADR-028, #366): Gemini 呼出前に掲示物 Q&A か判定し、
// 学習・進路は誘導なし拒否させるための決定論キーワード分類器。
export { classifyScope } from "./scope/classify.js";
export type { ScopeClassification, ScopeVerdict, OutOfScopeReason } from "./scope/classify.js";

// F06 out_of_scope 拒否ビルダー (ADR-028 §2/§4/§5): 学習・進路と判定された質問に、Gemini を
// 呼ばず多言語・中立丁寧・誘導なしの拒否文言を返す（route が import）。
export { buildScopeRefusal, normalizeLocale } from "./scope/refusal.js";
export type { SupportedLocale } from "./scope/refusal.js";

// 監査マッパー
export { toAiExtractionInsert } from "./audit.js";
export type { AiExtractionInsert, AuditMapParams } from "./audit.js";

// F03 (#154 item 2a): 抽出 → 監査行 → 永続化 オーケストレータ (persist は呼び出し側が DB に配線)
export { runStructuredExtraction } from "./run.js";
export type { PersistExtraction, RunExtractionParams, RunExtractionDeps } from "./run.js";

// F01 テキスト抽出レイヤ（PDF/Word/Excel/画像 → 素テキスト → structureContent 前段、#180）
export {
  detectFormat,
  ExtractorRegistry,
  createDefaultRegistry,
  extractText,
  createVisionOcrClient,
  TextExtractor,
  PdfExtractor,
  DocxExtractor,
  XlsxExtractor,
  ImageExtractor,
  assertStandardFontsAvailable,
  SOURCE_FORMATS,
  UnsupportedFormatError,
  LegacyOfficeFormatError,
  ExtractorNotConfiguredError,
  ExtractFailedError,
} from "./extract/index.js";
export type {
  SourceFormat,
  ExtractSource,
  ExtractMeta,
  ExtractedText,
  DocumentExtractor,
  OcrClient,
  OcrResult,
  RegistryOptions,
  VisionOcrConfig,
} from "./extract/index.js";
