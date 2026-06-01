import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F07 (#43, #464): validateEventInput (純検証) と recordSignageEvent (token 解決→tenant insert) の
 * テスト。`@kimiterrace/db` の resolveMagicLink/withTenantContext/events/contents と getDb/hashToken、
 * drizzle-orm の eq を mock し、RLS 文脈 (schoolId 強制)・PII allowlist・不正入力の倒し方に加え、
 * #464 の per-token rate limit (M-2) と contentId の自テナント可視性チェック (L-1) を検証する。
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
  contents: { id: { __col: "contents.id" } },
}));
// eq は SQL 式を組むだけ。可視性 SELECT の結果は tx.select モックが返す contentRows で制御するため、
// eq は引数を素通しする no-op に置き、drizzle 内部 (sql テンプレート) への依存を排す。
vi.mock("drizzle-orm", () => ({ eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }) }));
vi.mock("../../lib/db", () => ({ getDb: () => ({ __db: true }) }));
vi.mock("@/lib/magic-link/token", () => ({ hashToken }));

import {
  type EventIngestInput,
  SIGNAGE_EVENT_LIMIT,
  SIGNAGE_EVENT_WINDOW_MS,
  recordSignageEvent,
  signageEventRateLimiter,
  validateEventInput,
} from "../../lib/signage/event-ingest";

const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const CONTENT_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "66666666-6666-4666-8666-666666666666";
const AD_ID = "77777777-7777-4777-8777-777777777777";

let captured: Record<string, unknown>[];
let lastCtx: { schoolId?: string } | null;
/** 可視性 SELECT (contents) が返す行。空配列 = 自テナント不可視 (他校/不在)。 */
let contentRows: { id: string }[];
/** contents 可視性 SELECT の呼び出し回数 (contentId 省略時に走らないことを縛る)。 */
let selectCalls: number;

beforeEach(() => {
  vi.clearAllMocks();
  hashToken.mockImplementation((t: string) => `HASH(${t})`);
  captured = [];
  lastCtx = null;
  contentRows = [{ id: CONTENT_ID }];
  selectCalls = 0;
  signageEventRateLimiter.reset();
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
        select: () => {
          selectCalls += 1;
          return {
            from: () => ({ where: () => ({ limit: () => Promise.resolve(contentRows) }) }),
          };
        },
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

  // ---- L-1 (#464): contentId の自テナント可視性チェック (越境参照の解決不能化) ----
  it("L-1 (#464): 自テナントに可視な contentId はそのまま INSERT", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c" });
    contentRows = [{ id: CONTENT_ID }];
    const res = await recordSignageEvent("THETOKEN", { type: "tap", contentId: CONTENT_ID });
    expect(res).toEqual({ ok: true });
    expect(selectCalls).toBe(1);
    expect(captured[0]).toMatchObject({ contentId: CONTENT_ID, type: "tap" });
  });

  it("L-1 (#464): 不可視な contentId (RLS 下 0 行 = 他校/不在) は null に落として INSERT", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c" });
    contentRows = []; // 校 B の content uuid → 読み手 (校 A) の RLS では SELECT が 0 行
    const res = await recordSignageEvent("THETOKEN", { type: "tap", contentId: CONTENT_ID });
    expect(res).toEqual({ ok: true });
    expect(selectCalls).toBe(1);
    // events 行は残るが content_id は解決不能化され dangling な越境参照を残さない。
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ contentId: null, type: "tap" });
  });

  it("L-1 (#464): contentId 省略時は可視性 SELECT を行わない", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c" });
    const res = await recordSignageEvent("THETOKEN", { type: "view" });
    expect(res).toEqual({ ok: true });
    expect(selectCalls).toBe(0);
    expect(captured[0]).toMatchObject({ contentId: null });
  });

  // ---- M-2 (#464): per-token 固定窓レートリミット ----
  it("M-2 (#464): 同一 token の上限超過は rate_limited で解決も INSERT もしない", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c" });
    const now = 1_000_000;
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      const r = await recordSignageEvent("FLOODTOKEN", { type: "view" }, now);
      expect(r.ok).toBe(true);
    }
    const blocked = await recordSignageEvent("FLOODTOKEN", { type: "view" }, now);
    expect(blocked).toEqual({ ok: false, reason: "rate_limited" });
    // 超過分は DB 解決に到達しない: 解決・INSERT 数は上限ちょうど。
    expect(captured).toHaveLength(SIGNAGE_EVENT_LIMIT);
    expect(resolveMagicLink).toHaveBeenCalledTimes(SIGNAGE_EVENT_LIMIT);
  });

  it("M-2 (#464): rate limit は token 単位 (別 token を道連れにしない)", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c" });
    const now = 2_000_000;
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      await recordSignageEvent("TOKEN_A", { type: "view" }, now);
    }
    expect((await recordSignageEvent("TOKEN_A", { type: "view" }, now)).ok).toBe(false);
    // 別 token は自分の窓を持つので素通り (IP ではなく token 単位の証拠)。
    expect((await recordSignageEvent("TOKEN_B", { type: "view" }, now)).ok).toBe(true);
  });

  it("M-2 (#464): 窓を跨げば同一 token も再び通る (固定窓のリセット)", async () => {
    resolveMagicLink.mockResolvedValue({ id: "x", schoolId: SCHOOL_ID, classId: "c" });
    const t0 = 3_000_000;
    for (let i = 0; i < SIGNAGE_EVENT_LIMIT; i++) {
      await recordSignageEvent("ROLLTOKEN", { type: "view" }, t0);
    }
    expect((await recordSignageEvent("ROLLTOKEN", { type: "view" }, t0)).ok).toBe(false);
    expect(
      (await recordSignageEvent("ROLLTOKEN", { type: "view" }, t0 + SIGNAGE_EVENT_WINDOW_MS)).ok,
    ).toBe(true);
  });
});
