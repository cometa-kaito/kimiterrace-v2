import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS_PER_BATCH,
  MAX_PAYLOAD_BYTES,
  SIGNAGE_EVENT_TYPES,
  validateSignageEventBatch,
} from "../../lib/events/event-core";

/**
 * lib/events/event-core.ts (#43 F07) の unit テスト。
 *
 * 公開サイネージ端末から来る信頼できない行動ログ batch の検証。件数・型・サイズ・時刻範囲を固定し、
 * 1 件でも外れたら batch 全体を reject することを pin する (空虚緑でなく境界を突く)。
 */

const NOW = Date.parse("2026-05-31T12:00:00.000Z");
const UUID = "11111111-1111-4111-8111-111111111111";

function batch(events: unknown[]) {
  return validateSignageEventBatch({ events }, NOW);
}

describe("validateSignageEventBatch", () => {
  it("type のみの最小イベント → ok、contentId/occurredAt は null・payload は {} に正規化", () => {
    const r = batch([{ type: "view" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual([{ type: "view", contentId: null, occurredAt: null, payload: {} }]);
    }
  });

  it("view/tap/dwell すべて受理する (SIGNAGE_EVENT_TYPES)", () => {
    const r = batch(SIGNAGE_EVENT_TYPES.map((type) => ({ type })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(SIGNAGE_EVENT_TYPES.length);
  });

  it("contentId(UUID) + occurredAt(範囲内) + payload(object) を正規化する", () => {
    const occurredAt = new Date(NOW - 5_000).toISOString();
    const r = batch([{ type: "tap", contentId: UUID, occurredAt, payload: { x: 1 } }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]?.contentId).toBe(UUID);
      expect(r.value[0]?.occurredAt?.getTime()).toBe(NOW - 5_000);
      expect(r.value[0]?.payload).toEqual({ x: 1 });
    }
  });

  it("events が配列でない / 欠落 → reject", () => {
    expect(validateSignageEventBatch({}, NOW).ok).toBe(false);
    expect(validateSignageEventBatch({ events: "nope" }, NOW).ok).toBe(false);
    expect(validateSignageEventBatch(null, NOW).ok).toBe(false);
  });

  it("空配列 → reject", () => {
    expect(batch([]).ok).toBe(false);
  });

  it("MAX_EVENTS_PER_BATCH 超過 → reject、ちょうどは ok", () => {
    const one = { type: "view" };
    expect(batch(Array.from({ length: MAX_EVENTS_PER_BATCH }, () => one)).ok).toBe(true);
    expect(batch(Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => one)).ok).toBe(false);
  });

  it("signage で許可されない type ('ask') と未知 type は reject", () => {
    expect(batch([{ type: "ask" }]).ok).toBe(false); // ask は生徒 Q&A 経路 (F06)、端末からは不可
    expect(batch([{ type: "scroll" }]).ok).toBe(false);
    expect(batch([{ type: 123 }]).ok).toBe(false);
  });

  it("contentId が非 UUID → reject", () => {
    expect(batch([{ type: "view", contentId: "not-a-uuid" }]).ok).toBe(false);
    expect(batch([{ type: "view", contentId: 42 }]).ok).toBe(false);
  });

  it("occurredAt が非文字列 / パース不能 → reject", () => {
    expect(batch([{ type: "view", occurredAt: 123 }]).ok).toBe(false);
    expect(batch([{ type: "view", occurredAt: "not-a-date" }]).ok).toBe(false);
  });

  it("occurredAt が未来 (skew 超過) / 過去 (24h 超過) → reject", () => {
    const future = new Date(NOW + 10 * 60 * 1000).toISOString();
    const tooOld = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
    expect(batch([{ type: "view", occurredAt: future }]).ok).toBe(false);
    expect(batch([{ type: "view", occurredAt: tooOld }]).ok).toBe(false);
  });

  it("payload が object でない (配列/文字列) → reject", () => {
    expect(batch([{ type: "view", payload: [1, 2] }]).ok).toBe(false);
    expect(batch([{ type: "view", payload: "x" }]).ok).toBe(false);
  });

  it("payload が MAX_PAYLOAD_BYTES 超過 → reject", () => {
    const big = { blob: "a".repeat(MAX_PAYLOAD_BYTES + 1) };
    expect(batch([{ type: "view", payload: big }]).ok).toBe(false);
  });

  it("イベントがオブジェクトでない → reject", () => {
    expect(batch(["view"]).ok).toBe(false);
    expect(batch([null]).ok).toBe(false);
  });

  it("1 件でも不正なら batch 全体を reject (all-or-nothing)", () => {
    const r = batch([{ type: "view" }, { type: "ask" }, { type: "tap" }]);
    expect(r.ok).toBe(false);
  });
});
