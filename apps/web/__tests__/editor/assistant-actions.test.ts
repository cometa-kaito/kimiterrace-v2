import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 段C: assistDraftNoticesAction のセキュリティ分岐検証（DB/Vertex/auth はモック、model は deps 注入）。
 * PII soft-gate・AI_ENABLED kill-switch・レート制限・正常ドラフト・監査書込を固める。
 */

// vi.hoisted: vi.mock factory は巻き上げられるため、参照するフェイクは hoisted で先に生成する。
const h = vi.hoisted(() => {
  class FakeAiDisabledError extends Error {}
  return {
    AiDisabledError: FakeAiDisabledError,
    assertAiEnabled: vi.fn(),
    findSuspectedPersonalNames: vi.fn(),
    findUnmaskedPii: vi.fn(),
    maskPII: vi.fn(),
    unmaskPII: vi.fn(),
    requireRole: vi.fn(),
    insertValues: vi.fn(),
  };
});

vi.mock("@kimiterrace/ai", () => ({
  AiDisabledError: h.AiDisabledError,
  assertAiEnabled: h.assertAiEnabled,
  findSuspectedPersonalNames: h.findSuspectedPersonalNames,
  findUnmaskedPii: h.findUnmaskedPii,
  maskPII: h.maskPII,
  unmaskPII: h.unmaskPII,
  createPerSchoolRateLimiter: () => ({ tryAcquire: () => true }),
  createVertexModelClient: () => ({ generate: vi.fn() }),
}));
vi.mock("@/lib/auth/guard", () => ({ requireRole: h.requireRole }));
vi.mock("@/lib/db", () => ({
  withSession: (cb: (tx: unknown) => unknown) => cb({ insert: () => ({ values: h.insertValues }) }),
}));
vi.mock("@kimiterrace/db", () => ({ auditLog: {} }));

import { assistDraftNoticesAction } from "../../lib/editor/assistant-actions";

const CLASS_ID = "11111111-1111-4111-8111-111111111111";

function deps(overrides: Partial<{ generate: ReturnType<typeof vi.fn>; acquire: boolean }> = {}) {
  const generate =
    overrides.generate ??
    vi.fn().mockResolvedValue({
      text: '{"notices":[{"text":"連絡A","isHighlight":true}]}',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      modelVersion: "fake",
    });
  return {
    model: { generate },
    rateLimiter: { tryAcquire: vi.fn().mockReturnValue(overrides.acquire ?? true) },
    nowMs: 1000,
  };
}

beforeEach(() => {
  h.requireRole.mockResolvedValue({ uid: "u1", schoolId: "s1", role: "teacher" });
  h.assertAiEnabled.mockReset().mockImplementation(() => undefined);
  h.findSuspectedPersonalNames.mockReset().mockReturnValue([]);
  h.findUnmaskedPii.mockReset().mockReturnValue([]);
  h.maskPII.mockReset().mockImplementation((t: string) => ({ masked: t, dictionary: {} }));
  h.unmaskPII.mockReset().mockImplementation((t: string) => t);
  h.insertValues.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("assistDraftNoticesAction", () => {
  it("空入力は empty（認証前に弾く）", async () => {
    const r = await assistDraftNoticesAction("class", CLASS_ID, "   ", {}, deps());
    expect(r).toEqual({ ok: false, reason: "empty" });
  });

  it("氏名らしき語があり未 override なら pii_warning（送信しない）", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([
      { surface: "田中さん" },
      { surface: "田中さん" },
    ]);
    const d = deps();
    const r = await assistDraftNoticesAction("class", CLASS_ID, "田中さんが欠席", {}, d);
    expect(r).toEqual({ ok: false, reason: "pii_warning", suspectedSurfaces: ["田中さん"] });
    expect(d.model.generate).not.toHaveBeenCalled();
  });

  it("acknowledgePii で soft-gate を越えて生成する", async () => {
    h.findSuspectedPersonalNames.mockReturnValue([{ surface: "田中さん" }]);
    const d = deps();
    const r = await assistDraftNoticesAction(
      "class",
      CLASS_ID,
      "連絡を作って",
      { acknowledgePii: true },
      d,
    );
    expect(r.ok).toBe(true);
    expect(d.model.generate).toHaveBeenCalledOnce();
  });

  it("AI_ENABLED OFF は disabled", async () => {
    h.assertAiEnabled.mockImplementation(() => {
      throw new h.AiDisabledError();
    });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "連絡", {}, deps());
    expect(r).toEqual({ ok: false, reason: "disabled" });
  });

  it("レート制限超過は rate_limited（生成しない）", async () => {
    const d = deps({ acquire: false });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "連絡", {}, d);
    expect(r).toEqual({ ok: false, reason: "rate_limited" });
    expect(d.model.generate).not.toHaveBeenCalled();
  });

  it("正常時は notices を返し audit_log に書き込む", async () => {
    const d = deps();
    const r = await assistDraftNoticesAction("class", CLASS_ID, "明日は短縮授業", {}, d);
    expect(r).toEqual({ ok: true, notices: [{ text: "連絡A", isHighlight: true }] });
    expect(h.insertValues).toHaveBeenCalledOnce();
  });

  it("モデル応答が壊れていれば no_result", async () => {
    const d = deps({
      generate: vi.fn().mockResolvedValue({ text: "not json", usage: {}, modelVersion: "f" }),
    });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "連絡", {}, d);
    expect(r).toEqual({ ok: false, reason: "no_result" });
  });

  it("学校に属さない user は forbidden", async () => {
    h.requireRole.mockResolvedValue({ uid: "u1", schoolId: null, role: "teacher" });
    const r = await assistDraftNoticesAction("class", CLASS_ID, "連絡", {}, deps());
    expect(r).toEqual({ ok: false, reason: "forbidden" });
  });
});
