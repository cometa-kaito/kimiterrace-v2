import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F12 (#48-M): フィードバック投稿エンドポイント `POST /api/guide/feedback` の HTTP 挙動テスト。
 *
 * 実 DB は使わず submitFeedback / getDb を mock し、**Route Handler の責務** (非認証で受ける・
 * 入力検証・PRG redirect / JSON 応答・SECURITY DEFINER 関数への委譲) を検証する。RLS の実挙動
 * (匿名 INSERT の扉 / system_admin_only SELECT) は packages/db の RLS テスト (実 PG16) が担保。
 */

const { submitFeedback } = vi.hoisted(() => ({ submitFeedback: vi.fn() }));

vi.mock("../../lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@kimiterrace/db", () => ({ submitFeedback }));

import { POST } from "../../app/api/guide/feedback/route";
import { GUIDE_FEEDBACK_LIMIT, guideFeedbackRateLimiter } from "../../lib/guide/rate-limit";

const NEW_ID = "55555555-5555-4555-8555-555555555555";

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test/api/guide/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function formRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("http://test/api/guide/feedback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

beforeEach(() => {
  submitFeedback.mockReset();
  submitFeedback.mockResolvedValue(NEW_ID);
  // レートリミッタは module-level シングルトン。テスト間で状態が漏れないよう毎回リセット (#234)。
  guideFeedbackRateLimiter.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/guide/feedback (非認証 / 匿名投稿)", () => {
  it("JSON で必須スコアが揃えば 201 + id を返し、submitFeedback に正規化値を渡す", async () => {
    const res = await POST(
      jsonRequest({
        schoolName: " A校 ",
        studentReaction: "5",
        teacherUtility: 4,
        studentEpisode: "良かった",
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: NEW_ID });
    expect(submitFeedback).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        schoolName: "A校",
        studentReaction: 5,
        teacherUtility: 4,
        studentEpisode: "良かった",
        schoolId: null,
      }),
    );
  });

  it("フォーム送信は 303 で /guide?submitted=1 に redirect (PRG)", async () => {
    const res = await POST(
      formRequest({ studentReaction: "3", teacherUtility: "3", improvement: "なし" }),
    );
    expect(res.status).toBe(303);
    const loc = res.headers.get("location");
    expect(loc).toContain("/guide?submitted=1");
    expect(submitFeedback).toHaveBeenCalledTimes(1);
  });

  it("必須スコア欠落 / 範囲外は 400 で submitFeedback を呼ばない", async () => {
    const res1 = await POST(jsonRequest({ teacherUtility: 3 }));
    expect(res1.status).toBe(400);
    const res2 = await POST(jsonRequest({ studentReaction: 9, teacherUtility: 3 }));
    expect(res2.status).toBe(400);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("submitFeedback が throw した場合は 500 (PII を本文に出さない)", async () => {
    submitFeedback.mockRejectedValue(new Error("submit_feedback: student_reaction ..."));
    const res = await POST(jsonRequest({ studentReaction: 3, teacherUtility: 3 }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.ok).toBe(false);
    // エラー本文に内部メッセージ / PII を露出しない (一般文言)。
    expect(JSON.stringify(json)).not.toContain("student_reaction");
  });

  it("壊れた JSON は 400", async () => {
    const res = await POST(
      new Request("http://test/api/guide/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("同一 IP が上限を超えると 429 + Retry-After を返し、その投稿は submitFeedback を呼ばない (#234)", async () => {
    const ip = "203.0.113.42";
    const valid = { studentReaction: 4, teacherUtility: 4 };
    // 上限ちょうどまでは通る (各回 201、submitFeedback が呼ばれる)。
    for (let i = 0; i < GUIDE_FEEDBACK_LIMIT; i++) {
      const ok = await POST(jsonRequest(valid, { "x-forwarded-for": ip }));
      expect(ok.status).toBe(201);
    }
    expect(submitFeedback).toHaveBeenCalledTimes(GUIDE_FEEDBACK_LIMIT);

    // 上限 +1 件目は 429。body parse / DB へ進まないため submitFeedback は増えない。
    const limited = await POST(jsonRequest(valid, { "x-forwarded-for": ip }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("600");
    expect((await limited.json()).ok).toBe(false);
    expect(submitFeedback).toHaveBeenCalledTimes(GUIDE_FEEDBACK_LIMIT);
  });

  it("別 IP は独立した上限を持つ (一方の枯渇が他方を巻き込まない、#234)", async () => {
    const valid = { studentReaction: 3, teacherUtility: 3 };
    // IP-A を上限まで枯渇させる。
    for (let i = 0; i < GUIDE_FEEDBACK_LIMIT; i++) {
      await POST(jsonRequest(valid, { "x-forwarded-for": "198.51.100.1" }));
    }
    const aLimited = await POST(jsonRequest(valid, { "x-forwarded-for": "198.51.100.1" }));
    expect(aLimited.status).toBe(429);
    // IP-B は無関係に通る。
    const bOk = await POST(jsonRequest(valid, { "x-forwarded-for": "198.51.100.2" }));
    expect(bOk.status).toBe(201);
  });
});
