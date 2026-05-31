import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F07 (#43): validateEventInput (純検証) と recordSignageEvent (token 解決→tenant insert) のテスト。
 * `@kimiterrace/db` の resolveMagicLink/withTenantContext/events と getDb/hashToken を mock し、
 * RLS 文脈 (schoolId 強制) と PII allowlist・不正入力の倒し方を検証する。
 */

const { resolveMagicLink, withTenantContext, hashToken } = vi.hoisted(() => ({
  resolveMagicLink: vi.fn(),
  withTenantContext: vi.fn(),
  hashToken: vi.fn((t: string) => `HASH(${t})`),
}));

vi.mock("@kimiterrace/db", () => ({
  resolveMagicLink,
  withTenantContext,
  events: { __table: "events" },
}));
vi.mock("../../lib/db", () => ({ getDb: () => ({ __db: true }) }));
vi.mock("@/lib/magic-link/token", () => ({ hashToken }));

import {
  type EventIngestInput,
  recordSignageEvent,
  validateEventInput,
} from "../../lib/signage/event-ingest";

const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const CONTENT_ID = "55555555-5555-4555-8555-555555555555";
const CLIENT_ID = "66666666-6666-4666-8666-666666666666";
const AD_ID = "77777777-7777-4777-8777-777777777777";

let captured: Record<string, unknown>[];
let lastCtx: { schoolId?: string } | null;

beforeEach(() => {
  vi.clearAllMocks();
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
});
