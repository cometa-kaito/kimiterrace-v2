import { describe, expect, it } from "vitest";
import {
  extractionSchema,
  SUGGESTED_PUBLISH_SCOPES,
  schemaForKind,
} from "../../schema/extraction.js";

/**
 * F01 (2026-06-03): 抽出スキーマに追加した教員 UI 既定値の提案
 * （`suggestedPublishScope` / `suggestedPeriod`）の検証。
 *
 * - 提案は **任意** （AI が常に提案できるとは限らない）。無くても validate が通ること。
 * - 提案がある場合は値域（公開先 enum）・形（期間 start/end）を検証して通ること。
 * - 既存の必須メタ（confidenceScore / evidence）や discriminated union は壊れないこと。
 */
describe("extraction schema: 公開先・掲示期間の提案 (F01)", () => {
  const base = {
    kind: "announcement" as const,
    data: { title: "球技大会のお知らせ", body: "本文" },
    confidenceScore: 0.9,
    evidence: [{ text: "球技大会" }],
  };

  it("提案フィールドが無くても validate が通る（提案は任意）", () => {
    const parsed = extractionSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.suggestedPublishScope).toBeUndefined();
      expect(parsed.data.suggestedPeriod).toBeUndefined();
    }
  });

  it("公開先・期間の提案ありを validate して保持する", () => {
    const parsed = extractionSchema.safeParse({
      ...base,
      suggestedPublishScope: "school",
      suggestedPeriod: { start: "2026-06-10", end: "2026-06-20" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.suggestedPublishScope).toBe("school");
      expect(parsed.data.suggestedPeriod).toEqual({ start: "2026-06-10", end: "2026-06-20" });
    }
  });

  it("期間は片端だけの提案も許容する（end のみ）", () => {
    const parsed = extractionSchema.safeParse({
      ...base,
      suggestedPeriod: { end: "2026-06-20" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.suggestedPeriod).toEqual({ end: "2026-06-20" });
    }
  });

  it("許可値以外の公開先提案は弾く", () => {
    const parsed = extractionSchema.safeParse({ ...base, suggestedPublishScope: "everyone" });
    expect(parsed.success).toBe(false);
  });

  it("提案の値域は DB publishScope enum と同一（school/class/homeroom/private）", () => {
    expect([...SUGGESTED_PUBLISH_SCOPES]).toEqual(["school", "class", "homeroom", "private"]);
  });

  it("提案フィールドは全種別に追加されている（schedule でも通る）", () => {
    const schedule = schemaForKind("schedule").safeParse({
      kind: "schedule",
      data: { entries: [{ period: 1, subject: "数学" }] },
      confidenceScore: 0.7,
      evidence: [],
      suggestedPublishScope: "class",
    });
    expect(schedule.success).toBe(true);
    if (schedule.success) {
      expect(schedule.data.suggestedPublishScope).toBe("class");
    }
  });
});
