import { describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResponse } from "../../model/client.js";
import { FixedWindowRateLimiter } from "../../rate-limit.js";
import { PiiLeakError, RateLimitExceededError, structureContent } from "../../structure.js";

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

/** スクリプト化したフェイクモデル。送られた request を記録し、用意した応答を順に返す。 */
function fakeModel(responses: string[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  return {
    requests,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      requests.push(req);
      const text = responses[Math.min(i, responses.length - 1)] ?? "";
      i += 1;
      return { text, usage: USAGE, modelVersion: "gemini-1.5-pro-002" };
    },
  };
}

const announcement = (title: string, confidence = 0.9) =>
  JSON.stringify({
    kind: "announcement",
    data: { title, body: "本文" },
    confidenceScore: confidence,
    evidence: [{ text: "根拠" }],
  });

describe("structureContent", () => {
  it("初回成功: 構造化結果を返し PII を逆変換する", async () => {
    const model = fakeModel([announcement("{{STUDENT_001}}が欠席")]);
    const res = await structureContent({
      kind: "announcement",
      input: "田中太郎が欠席",
      piiEntries: [{ value: "田中太郎", category: "STUDENT" }],
      model,
    });
    expect(res.status).toBe("success");
    expect(res.attempts).toBe(1);
    expect(res.confidenceScore).toBe(0.9);
    expect(res.extraction).toMatchObject({
      kind: "announcement",
      data: { title: "田中太郎が欠席" },
    });
    expect(res.usage).toEqual(USAGE);
    expect(res.modelVersion).toBe("gemini-1.5-pro-002");
    expect(res.rawInputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("送信プロンプトに生 PII を含めず、マスク済みトークンを送る", async () => {
    const model = fakeModel([announcement("{{STUDENT_001}}")]);
    await structureContent({
      kind: "announcement",
      input: "田中太郎が欠席",
      piiEntries: [{ value: "田中太郎", category: "STUDENT" }],
      model,
    });
    expect(model.requests[0]?.user).not.toContain("田中太郎");
    expect(model.requests[0]?.user).toContain("{{STUDENT_001}}");
  });

  it("不正 JSON はリトライし、2 回目で成功する", async () => {
    const model = fakeModel(["これは JSON ではない", announcement("お知らせ")]);
    const res = await structureContent({ kind: "announcement", input: "x", model });
    expect(res.status).toBe("success");
    expect(res.attempts).toBe(2);
    // リトライ時のプロンプトに修復ヒントが付く。
    expect(model.requests[1]?.user).toContain("スキーマ検証に失敗");
  });

  it("confidence_score 欠落はスキーマ違反として弾く（必須・ADR-017）", async () => {
    const noConfidence = JSON.stringify({
      kind: "announcement",
      data: { title: "t", body: "b" },
      evidence: [],
    });
    const model = fakeModel([noConfidence, announcement("ok")]);
    const res = await structureContent({ kind: "announcement", input: "x", model });
    expect(res.attempts).toBe(2);
    expect(res.status).toBe("success");
  });

  it("最大リトライ超過で failed を返す（既定 maxRetries=2 → 計 3 回）", async () => {
    const model = fakeModel(["不正"]);
    const res = await structureContent({ kind: "announcement", input: "x", model });
    expect(res.status).toBe("failed");
    expect(res.attempts).toBe(3);
    expect(res.extraction).toBeNull();
    expect(res.confidenceScore).toBeNull();
    expect(res.errorMessage).toBeTruthy();
    expect(res.rawInputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("公開先・掲示期間の提案を構造化結果に持ち越す（F01、提案あり）", async () => {
    const withSuggestions = JSON.stringify({
      kind: "announcement",
      data: { title: "球技大会", body: "本文" },
      confidenceScore: 0.9,
      evidence: [{ text: "球技大会" }],
      suggestedPublishScope: "school",
      suggestedPeriod: { start: "2026-06-10", end: "2026-06-20" },
    });
    const res = await structureContent({
      kind: "announcement",
      input: "球技大会を全校に掲示",
      model: fakeModel([withSuggestions]),
    });
    expect(res.status).toBe("success");
    expect(res.extraction).toMatchObject({
      suggestedPublishScope: "school",
      suggestedPeriod: { start: "2026-06-10", end: "2026-06-20" },
    });
  });

  it("提案が無い応答も成功する（提案は任意・F01）", async () => {
    const res = await structureContent({
      kind: "announcement",
      input: "x",
      model: fakeModel([announcement("ok")]),
    });
    expect(res.status).toBe("success");
    expect(res.extraction?.suggestedPublishScope).toBeUndefined();
    expect(res.extraction?.suggestedPeriod).toBeUndefined();
  });

  it("schedule 種別のペイロードを検証する", async () => {
    const schedule = JSON.stringify({
      kind: "schedule",
      data: { entries: [{ period: 1, subject: "数学" }] },
      confidenceScore: 0.8,
      evidence: [],
    });
    const res = await structureContent({
      kind: "schedule",
      input: "1限 数学",
      model: fakeModel([schedule]),
    });
    expect(res.status).toBe("success");
    expect(res.extraction).toMatchObject({ data: { entries: [{ period: 1, subject: "数学" }] } });
  });

  it("レート上限超過で RateLimitExceededError を投げる", async () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    const base = {
      kind: "announcement" as const,
      input: "x",
      model: fakeModel([announcement("ok")]),
      rateLimiter: limiter,
      schoolId: "school-1",
      nowMs: 1_000,
    };
    await expect(structureContent(base)).resolves.toMatchObject({ status: "success" });
    await expect(structureContent({ ...base, nowMs: 2_000 })).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it("fail-closed: マスク後に PII が残ると送信せず PiiLeakError を投げる", async () => {
    // パターン検出を切ると電話がマスクされず残存 → ガードが発火し、モデルは呼ばれない。
    const model = fakeModel([announcement("ok")]);
    await expect(
      structureContent({
        kind: "announcement",
        input: "代表は 03-1111-2222 です",
        model,
        maskOptions: { detectPhones: false },
      }),
    ).rejects.toBeInstanceOf(PiiLeakError);
    expect(model.requests).toHaveLength(0);
  });
});
