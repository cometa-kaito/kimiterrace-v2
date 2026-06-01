import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F07 (#43): validateEventInput (純検証) と recordSignageEvent (token 解決→tenant insert) のテスト。
 * `@kimiterrace/db` の resolveMagicLink/withTenantContext/events と getDb/hashToken を mock し、
 * RLS 文脈 (schoolId 強制) と PII allowlist・不正入力の倒し方を検証する。
 */

const { resolveMagicLink, withTenantContext, getEffectiveAdsForClass, hashToken } = vi.hoisted(
  () => ({
    resolveMagicLink: vi.fn(),
    withTenantContext: vi.fn(),
    getEffectiveAdsForClass: vi.fn(),
    hashToken: vi.fn((t: string) => `HASH(${t})`),
  }),
);

vi.mock("@kimiterrace/db", () => ({
  resolveMagicLink,
  withTenantContext,
  getEffectiveAdsForClass,
  events: { __table: "events" },
}));
vi.mock("../../lib/db", () => ({ getDb: () => ({ __db: true }) }));
vi.mock("@/lib/magic-link/token", () => ({ hashToken }));

import {
  type EventIngestInput,
  recordSignageEvent,
  validateEventInput,
} from "../../lib/signage/event-ingest";
import {
  SIGNAGE_EVENT_LIMIT,
  SIGNAGE_EVENT_WINDOW_MS,
  signageEventRateLimiter,
} from "../../lib/signage/event-rate-limit";

const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const CONTENT_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "66666666-6666-4666-8666-666666666666";
const AD_ID = "77777777-7777-4777-8777-777777777777";

let captured: Record<string, unknown>[];
let lastCtx: { schoolId?: string } | null;

beforeEach(() => {
  vi.clearAllMocks();
  // module-level シングルトンの窓状態をテスト間で隔離する (M-2 #464)。
  signageEventRateLimiter.reset();
  hashToken.mockImplementation((t: string) => `HASH(${t})`);
  captured = [];
  lastCtx = null;
  withTenantContext.mockImplementation(
    async (_db: unknown, ctx: { schoolId?: string }, fn: (tx: unknown) => Promise<unknown>) => {
      lastCtx = ctx;
      const tx = {
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            captured.push(v);
            return Promise.resolve(undefined);
          },
        }),
      };
      return fn(tx);
    },
  );
});

describe("validateEventInput", () => {
  it("view/tap は受理し、省略時 contentId=null・payload は空", () => {
    for (const type of ["view", "tap"] as const) {
      const v = validateEventInput({ type });
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.value).toEqual({ type, contentId: null, payload: {} });
      }
    }
  });

  it("contentId/clientId/slotIndex/adId を検証して payload allowlist に載せる", () => {
    const v = validateEventInput({
      type: "tap",
      contentId: CONTENT_ID,
      clientId: CLIENT_ID,
      slotIndex: 3,
      adId: AD_ID,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.contentId).toBe(CONTENT_ID);
      expect(v.value.payload).toEqual({ clientId: CLIENT_ID, slotIndex: 3, adId: AD_ID });
    }
  });

  it("dwell/ask/未知種別は invalid (本スライス対象外)", () => {
    for (const type of ["dwell", "ask", "presence", "", 1, null]) {
      expect(validateEventInput({ type }).ok).toBe(false);
    }
  });

  it("uuid でない contentId/clientId/adId は invalid", () => {
    expect(validateEventInput({ type: "view", contentId: "nope" }).ok).toBe(false);
    expect(validateEventInput({ type: "view", clientId: "nope" }).ok).toBe(false);
    expect(validateEventInput({ type: "view", adId: "nope" }).ok).toBe(false);
  });

  it("slotIndex は非負整数のみ (負/小数/非数は invalid)", () => {
    expect(validateEventInput({ type: "view", slotIndex: -1 }).ok).toBe(false);
    expect(validateEventInput({ type: "view", slotIndex: 1.5 }).ok).toBe(false);
    expect(validateEventInput({ type: "view", slotIndex: "2" }).ok).toBe(false);
  });

  it("PII allowlist: 未知キー (氏名等) は payload に残さない (ルール4)", () => {
    // 端末が送りうる余分キー (氏名等) の混入を再現する。型は崩さず Record 経由で追加する。
    const raw: EventIngestInput = { type: "view" };
    (raw as Record<string, unknown>).studentName = "田中太郎";
    const v = validateEventInput(raw);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.payload).toEqual({});
      expect(JSON.stringify(v.value)).not.toContain("田中");
    }
  });
});

describe("recordSignageEvent", () => {
  it("正常系: token を hash 解決し、schoolId 強制の tenant 文脈で events に INSERT", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c" });
    const res = await recordSignageEvent("THETOKEN", {
      type: "view",
      contentId: CONTENT_ID,
      clientId: CLIENT_ID,
      slotIndex: 0,
    });
    expect(res).toEqual({ ok: true });
    // DB へは平文でなく hash を渡す (ルール5)。
    expect(hashToken).toHaveBeenCalledWith("THETOKEN");
    expect(resolveMagicLink).toHaveBeenCalledWith(expect.anything(), "HASH(THETOKEN)");
    // RLS 文脈は解決した schoolId のみ (client 由来でない)。
    expect(lastCtx).toEqual({ schoolId: SCHOOL_ID });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      schoolId: SCHOOL_ID,
      contentId: CONTENT_ID,
      type: "view",
      payload: { clientId: CLIENT_ID, slotIndex: 0 },
    });
    // occurred_at はクライアント時刻を信用せず DB 既定に委ねる (insert に含めない)。
    expect(captured[0]).not.toHaveProperty("occurredAt");
  });

  it("入力不正は reason=invalid で、token 解決も INSERT もしない", async () => {
    const res = await recordSignageEvent("THETOKEN", { type: "dwell" });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(resolveMagicLink).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("token 無効 (resolve null) は reason=gone で INSERT しない", async () => {
    resolveMagicLink.mockResolvedValue(null);
    const res = await recordSignageEvent("BADTOKEN", { type: "view" });
    expect(res).toEqual({ ok: false, reason: "gone" });
    expect(captured).toHaveLength(0);
  });

  it("空 token は解決を試みず gone", async () => {
    const res = await recordSignageEvent("", { type: "view" });
    expect(res).toEqual({ ok: false, reason: "gone" });
    expect(resolveMagicLink).not.toHaveBeenCalled();
  });

  // ---- L-1 (#265): adId 実在照合 (effective_ads_per_class) ----
  it("L-1: adId が当該クラスの実効広告に実在すれば採用して INSERT", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c1" });
    getEffectiveAdsForClass.mockResolvedValue([{ adId: AD_ID }]);
    const res = await recordSignageEvent("THETOKEN", { type: "view", adId: AD_ID });
    expect(res).toEqual({ ok: true });
    // 実在照合は解決した classId に対して行う (RLS 文脈内 = tx 経由)。
    expect(getEffectiveAdsForClass).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ payload: { adId: AD_ID } });
  });

  it("L-1: 実効広告に無い adId は invalid で INSERT しない (到達数の水増し防止)", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c1" });
    getEffectiveAdsForClass.mockResolvedValue([{ adId: "99999999-9999-4999-8999-999999999999" }]);
    const res = await recordSignageEvent("THETOKEN", { type: "view", adId: AD_ID });
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(captured).toHaveLength(0);
  });

  it("L-1: adId 不在の一般 view は実在照合をスキップし従来どおり INSERT", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c1" });
    const res = await recordSignageEvent("THETOKEN", { type: "view", clientId: CLIENT_ID });
    expect(res).toEqual({ ok: true });
    expect(getEffectiveAdsForClass).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
  });

  // ---- M-2 (#464): per-token 固定ウィンドウ rate limit ----
  it("M-2: 同一 token が上限を超えると rate_limited で解決にも INSERT にも到達しない", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c1" });
    const now = 1000;
    // 同一窓・同一 token (= hash 済みキー) を上限まで埋める。
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      expect(signageEventRateLimiter.tryAcquire("HASH(THETOKEN)", now)).toBe(true);
    }
    const res = await recordSignageEvent("THETOKEN", { type: "view" }, now);
    expect(res).toEqual({ ok: false, reason: "rate_limited" });
    // DB コストを断つ: 上限超過は SECURITY DEFINER 解決にも tenant INSERT にも到達しない。
    expect(resolveMagicLink).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("M-2: 別 token は独立した窓を持ち巻き込まれない", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c1" });
    const now = 1000;
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      signageEventRateLimiter.tryAcquire("HASH(TOKEN_A)", now);
    }
    // TOKEN_A は枯渇しているが、別 token は通常どおり記録される。
    const res = await recordSignageEvent("THETOKEN", { type: "view" }, now);
    expect(res).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
  });

  it("M-2: 窓を跨ぐと再び許可される (固定ウィンドウのリセット)", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c1" });
    const now = 1000;
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      signageEventRateLimiter.tryAcquire("HASH(THETOKEN)", now);
    }
    expect((await recordSignageEvent("THETOKEN", { type: "view" }, now)).ok).toBe(false);
    const res = await recordSignageEvent(
      "THETOKEN",
      { type: "view" },
      now + SIGNAGE_EVENT_WINDOW_MS,
    );
    expect(res).toEqual({ ok: true });
  });

  it("M-2: 不正入力は validate が先に弾き rate limit バケットを消費しない", async () => {
    const res = await recordSignageEvent("THETOKEN", { type: "dwell" }, 1000);
    expect(res).toEqual({ ok: false, reason: "invalid" });
    // validate が limiter/hash の前で倒すため、token の窓は作られない。
    expect(signageEventRateLimiter.size()).toBe(0);
  });

  it("M-2: 空 token は hash/limiter を通らず gone (バケット非生成)", async () => {
    const res = await recordSignageEvent("", { type: "view" }, 1000);
    expect(res).toEqual({ ok: false, reason: "gone" });
    expect(signageEventRateLimiter.size()).toBe(0);
  });
});
