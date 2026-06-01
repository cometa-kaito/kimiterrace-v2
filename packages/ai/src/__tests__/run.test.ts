import { describe, expect, it, vi } from "vitest";
import type { ModelClient, ModelUsage } from "../model/client.js";
import { runStructuredExtraction } from "../run.js";
import {
  PiiLeakError,
  RateLimitExceededError,
  type StructureRequest,
  type StructureResult,
} from "../structure.js";

/**
 * F03 (#154 item 2a): runStructuredExtraction オーケストレータの単体テスト。
 * structureContent 自体は structure.test.ts で検証済なので、ここでは **依存注入した fake structure** で
 * seam の契約 (成功/失敗を監査、rate-limit/PII-leak は監査せず伝播、persist 失敗は伝播) を突く。
 */

const USAGE: ModelUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

// 実行されない stub model (fake structure が request を無視するため)。
const noopModel: ModelClient = {
  generate: async () => ({ text: "{}", usage: USAGE, modelVersion: "stub" }),
};

const baseRequest: StructureRequest = { kind: "summary", input: "今日の連絡", model: noopModel };

const successResult: StructureResult = {
  status: "success",
  kind: "summary",
  extraction: {
    kind: "summary",
    data: { summary: "体育祭は晴天実施", keyPoints: ["集合8時"] },
    confidenceScore: 0.92,
    evidence: [{ text: "体育祭は予定通り" }],
  },
  confidenceScore: 0.92,
  modelVersion: "gemini-test-1",
  usage: USAGE,
  rawInputHash: "h".repeat(64),
  attempts: 1,
  errorMessage: null,
};

const failedResult: StructureResult = {
  status: "failed",
  kind: "summary",
  extraction: null,
  confidenceScore: null,
  modelVersion: "gemini-test-1",
  usage: USAGE,
  rawInputHash: "h".repeat(64),
  attempts: 3,
  errorMessage: "Zod 検証に 3 回失敗",
};

const IDS = { schoolId: "school-1", contentId: "content-1", actorUserId: "user-1" };

describe("runStructuredExtraction (#154 item 2a)", () => {
  it("成功した抽出を ai_extractions 行へ写像して persist し、outcome を返す", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const structure = vi.fn().mockResolvedValue(successResult);

    const result = await runStructuredExtraction(
      { request: baseRequest, ...IDS, persist },
      { structure },
    );

    expect(result).toBe(successResult);
    expect(persist).toHaveBeenCalledTimes(1);
    const row = persist.mock.calls[0]?.[0];
    // toAiExtractionInsert の写像が通っていることをフィールドで確認。
    expect(row).toMatchObject({
      schoolId: "school-1",
      contentId: "content-1",
      extractionKind: "summary",
      confidenceScore: 0.92,
      evidence: [{ text: "体育祭は予定通り" }],
      rawInputHash: "h".repeat(64),
      modelVersion: "gemini-test-1",
      status: "success",
      errorMessage: null,
      // #154 F03 受け入れ条件: token 使用量も監査に写る (ModelUsage → ai_extractions の集計列)。
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      createdBy: "user-1",
      updatedBy: "user-1",
    });
  });

  it("失敗した抽出も監査する (status=failed, confidence は 0 に正規化, evidence 空, token は使った分を記録)", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const structure = vi.fn().mockResolvedValue(failedResult);

    const result = await runStructuredExtraction(
      { request: baseRequest, ...IDS, persist },
      { structure },
    );

    expect(result.status).toBe("failed");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      confidenceScore: 0, // toAiExtractionInsert が null→0 に正規化 (NOT NULL 列)
      evidence: [],
      errorMessage: "Zod 検証に 3 回失敗",
      // 失敗 (リトライ尽き) でもモデルには到達しているため token は実消費を記録する。
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("システム実行 (actorUserId/contentId 省略) は createdBy/contentId が null になる", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const structure = vi.fn().mockResolvedValue(successResult);

    await runStructuredExtraction(
      { request: baseRequest, schoolId: "school-1", persist },
      { structure },
    );

    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      schoolId: "school-1",
      contentId: null,
      createdBy: null,
      updatedBy: null,
    });
  });

  it("request.schoolId と監査 schoolId の不一致は fail-safe で弾く (structure/persist 未到達)", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const structure = vi.fn().mockResolvedValue(successResult);

    await expect(
      runStructuredExtraction(
        { request: { ...baseRequest, schoolId: "school-OTHER" }, ...IDS, persist },
        { structure },
      ),
    ).rejects.toThrow(/不一致/);
    expect(structure).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("RateLimitExceededError は監査せず呼び出し側へ伝播する (モデル送信前の throttle)", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const structure = vi.fn().mockRejectedValue(new RateLimitExceededError("school-1"));

    await expect(
      runStructuredExtraction({ request: baseRequest, ...IDS, persist }, { structure }),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(persist).not.toHaveBeenCalled();
  });

  it("PiiLeakError は監査せず呼び出し側へ伝播する (fail-closed、モデル未送信)", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const structure = vi.fn().mockRejectedValue(new PiiLeakError(2));

    await expect(
      runStructuredExtraction({ request: baseRequest, ...IDS, persist }, { structure }),
    ).rejects.toBeInstanceOf(PiiLeakError);
    expect(persist).not.toHaveBeenCalled();
  });

  it("persist の失敗は握りつぶさず伝播する (監査欠落を呼び出し側が検知できる)", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("DB 一時障害"));
    const structure = vi.fn().mockResolvedValue(successResult);

    await expect(
      runStructuredExtraction({ request: baseRequest, ...IDS, persist }, { structure }),
    ).rejects.toThrow("DB 一時障害");
  });
});
