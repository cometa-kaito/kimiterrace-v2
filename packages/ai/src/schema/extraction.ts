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

// すべての抽出結果が共通で持つメタ（自己評価 + 根拠）。
const metaShape = {
  confidenceScore: z.number().min(0).max(1),
  evidence: z.array(evidenceItemSchema).default([]),
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
