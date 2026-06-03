import { z } from "zod";

/**
 * F03 構造化出力の Zod スキーマ（ADR-017）。
 *
 * - `confidenceScore` は **必須**（ADR-017 決定3、F04.3 確信度フラグの安全網が依存）。
 * - `evidence` は抽出根拠のソース引用（ADR-017 決定4、教員レビューの説明可能性）。
 * - 抽出種別ごとに `data` ペイロードを変え、`kind` で discriminated union を構成する。
 *
 * このスキーマは LLM 応答の validate に使うと同時に、CLAUDE.md ルール3（型は単一ソース）に従い
 * フロント/バックの型を `z.infer` で派生させる起点になる。`aiExtractionKind` の値域は
 * `@kimiterrace/db` の同名 pgEnum と一致させること（DB 列との往復のため）。
 */

/** 抽出種別。`@kimiterrace/db` の `aiExtractionKind` pgEnum と同一値域。 */
export const EXTRACTION_KINDS = ["schedule", "announcement", "summary", "tag"] as const;
export type ExtractionKind = (typeof EXTRACTION_KINDS)[number];

/** 抽出根拠の引用（どのソース文字列から導いたか）。 */
export const evidenceItemSchema = z.object({
  text: z.string().min(1),
  source: z.string().optional(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

/**
 * AI が提案できる公開先（publish scope）の値域。
 *
 * 単一ソースは `@kimiterrace/db` の `publishScope` pgEnum（= `apps/web` の `PUBLISH_SCOPES`、
 * publish-core.ts も同 enum 由来）。CLAUDE.md ルール3 に従い手書きの二重定義を避けたいが、
 * `packages/ai` は `@kimiterrace/db` に依存しない方針（Next バンドル/モデル層へ DB を引き込まない）
 * のため、ここでは enum の **値域だけ** を `as const` で写す。値が増減した場合は
 * `apps/web/lib/contents/publish-core.ts` の `_ExhaustivePublishScopeCheck`（enum 全メンバが
 * 配列に含まれることを型レベルで強制）と本配列の両方を更新する（DB enum が最終強制点）。
 */
export const SUGGESTED_PUBLISH_SCOPES = ["school", "class", "homeroom", "private"] as const;
export type SuggestedPublishScope = (typeof SUGGESTED_PUBLISH_SCOPES)[number];

/**
 * AI が提案する掲示期間（ISO 日付/日時文字列、両端 optional）。
 * 教員はエディタで上書きできる前提のため、提案できない端は省略する（捏造しない）。
 */
export const suggestedPeriodSchema = z.object({
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
});
export type SuggestedPeriod = z.infer<typeof suggestedPeriodSchema>;

// すべての抽出結果が共通で持つメタ（自己評価 + 根拠 + 教員 UI 既定値の提案）。
const metaShape = {
  confidenceScore: z.number().min(0).max(1),
  evidence: z.array(evidenceItemSchema).default([]),
  // 公開先・掲示期間の提案（2026-06-03 ユーザー確定、F01）。AI が常に提案できるとは限らないため
  // **任意**。存在すれば教員編集 UI の既定値として pre-fill し、無ければ従来の既定にフォールバックする。
  // 教員は常に上書き可能（提案は強制でない）。
  suggestedPublishScope: z.enum(SUGGESTED_PUBLISH_SCOPES).optional(),
  suggestedPeriod: suggestedPeriodSchema.optional(),
};

const scheduleEntry = z.object({
  period: z.number().int().min(0),
  subject: z.string().min(1),
  date: z.string().optional(),
  note: z.string().optional(),
});

const scheduleSchema = z.object({
  kind: z.literal("schedule"),
  data: z.object({ entries: z.array(scheduleEntry) }),
  ...metaShape,
});

const announcementSchema = z.object({
  kind: z.literal("announcement"),
  data: z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    dueDate: z.string().optional(),
  }),
  ...metaShape,
});

const summarySchema = z.object({
  kind: z.literal("summary"),
  data: z.object({
    summary: z.string().min(1),
    keyPoints: z.array(z.string()).default([]),
  }),
  ...metaShape,
});

const tagSchema = z.object({
  kind: z.literal("tag"),
  data: z.object({ tags: z.array(z.string().min(1)) }),
  ...metaShape,
});

/** 全種別を統合した discriminated union。`kind` で分岐する。 */
export const extractionSchema = z.discriminatedUnion("kind", [
  scheduleSchema,
  announcementSchema,
  summarySchema,
  tagSchema,
]);
export type Extraction = z.infer<typeof extractionSchema>;

const KIND_TO_SCHEMA = {
  schedule: scheduleSchema,
  announcement: announcementSchema,
  summary: summarySchema,
  tag: tagSchema,
} as const;

/** 指定種別に対応する Zod スキーマを返す。 */
export function schemaForKind(kind: ExtractionKind): (typeof KIND_TO_SCHEMA)[ExtractionKind] {
  return KIND_TO_SCHEMA[kind];
}
