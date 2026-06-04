import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractTeacherInputResult } from "../../lib/ai/extract-teacher-input";

/**
 * F03 (#154): `POST /api/teacher-inputs/:id/extract` の HTTP 写像検証。
 *
 * コア (extractTeacherInput) は別テストで担保するため mock し、route の責務 (kind 検証 + 結果 → status)
 * のみを突く。
 */
const { extractTeacherInput } = vi.hoisted(() => ({ extractTeacherInput: vi.fn() }));
vi.mock("../../lib/ai/extract-teacher-input", () => ({ extractTeacherInput }));

import { POST } from "../../app/api/teacher-inputs/[id]/extract/route";

function req(body: unknown): Request {
  return new Request("http://test/api/teacher-inputs/abc/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: "input-1" }) };

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs(); // #289: AI_ENABLED の stub を後続テストへ漏らさない (setup の "true" へ復元)。
});

describe("POST /api/teacher-inputs/:id/extract", () => {
  it("AI 無効 (AI_ENABLED!=true) は 503、コアを呼ばない (#289 kill-switch)", async () => {
    vi.stubEnv("AI_ENABLED", "false");
    // 妥当な kind でも gate (POST 冒頭) が kind 検証より前に短絡する。
    const res = await POST(req({ kind: "schedule" }), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
    expect(extractTeacherInput).not.toHaveBeenCalled();
  });

  it("成功は 200 + status / confidenceScore、kind と id をコアに渡す", async () => {
    extractTeacherInput.mockResolvedValue({
      ok: true,
      status: "success",
      confidenceScore: 0.8,
    } satisfies ExtractTeacherInputResult);

    const res = await POST(req({ kind: "schedule" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "success", confidenceScore: 0.8 });
    // deps は既定 (3 番目 undefined)、opts に acknowledgePii (本体未指定なので false)。
    expect(extractTeacherInput).toHaveBeenCalledWith("input-1", "schedule", undefined, {
      acknowledgePii: false,
    });
  });

  it("acknowledgePii=true を本体から core の opts に渡す (ADR-030 override 再送)", async () => {
    extractTeacherInput.mockResolvedValue({
      ok: true,
      status: "success",
      confidenceScore: 0.5,
    } satisfies ExtractTeacherInputResult);
    await POST(req({ kind: "announcement", acknowledgePii: true }), ctx);
    expect(extractTeacherInput).toHaveBeenCalledWith("input-1", "announcement", undefined, {
      acknowledgePii: true,
    });
  });

  it("pii_warning は 409 + suspectedSurfaces を返す (ADR-030 soft-gate warn)", async () => {
    extractTeacherInput.mockResolvedValue({
      ok: false,
      reason: "pii_warning",
      suspectedSurfaces: ["田中さん", "佐藤さん"],
    } satisfies ExtractTeacherInputResult);
    const res = await POST(req({ kind: "announcement" }), ctx);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; suspectedSurfaces: string[] };
    expect(json.ok).toBe(false);
    expect(json.suspectedSurfaces).toEqual(["田中さん", "佐藤さん"]);
  });

  it("不正な kind は 400、コアを呼ばない", async () => {
    const res = await POST(req({ kind: "bogus" }), ctx);
    expect(res.status).toBe(400);
    expect(extractTeacherInput).not.toHaveBeenCalled();
  });

  it("壊れた JSON は 400", async () => {
    const res = await POST(req("{ not json"), ctx);
    expect(res.status).toBe(400);
    expect(extractTeacherInput).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["no_transcript", 404],
    ["rate_limited", 429],
    ["pii_leak", 422],
    ["error", 500],
  ] as const)("reason=%s → HTTP %i", async (reason, status) => {
    extractTeacherInput.mockResolvedValue({ ok: false, reason });
    const res = await POST(req({ kind: "announcement" }), ctx);
    expect(res.status).toBe(status);
    expect((await res.json()).ok).toBe(false);
  });

  it("rate_limited は Retry-After ヘッダを付ける", async () => {
    extractTeacherInput.mockResolvedValue({ ok: false, reason: "rate_limited" });
    const res = await POST(req({ kind: "schedule" }), ctx);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
