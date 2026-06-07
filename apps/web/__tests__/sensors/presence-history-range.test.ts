import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESENCE_RANGE,
  PRESENCE_RANGE_KEYS,
  normalizePresenceRangeKey,
  presenceRangeOptions,
  resolvePresenceRange,
} from "@/lib/sensors/presence-history-range";

/**
 * F13: presence 履歴ページの期間プリセット解決ロジックの単体検証（純関数・now 固定で決定的）。
 */

const NOW = new Date("2026-06-08T03:00:00.000Z"); // JST 12:00

describe("normalizePresenceRangeKey", () => {
  it("既知キーはそのまま", () => {
    for (const k of PRESENCE_RANGE_KEYS) {
      expect(normalizePresenceRangeKey(k)).toBe(k);
    }
  });

  it("未知/未指定は既定(7d)にフォールバック", () => {
    expect(normalizePresenceRangeKey("bogus")).toBe(DEFAULT_PRESENCE_RANGE);
    expect(normalizePresenceRangeKey(undefined)).toBe("7d");
    expect(normalizePresenceRangeKey(123)).toBe("7d");
  });
});

describe("resolvePresenceRange", () => {
  it("7d は now-7日 〜 now+1分", () => {
    const r = resolvePresenceRange("7d", NOW);
    expect(r.key).toBe("7d");
    expect(r.to.getTime()).toBe(NOW.getTime() + 60_000);
    expect(r.from.getTime()).toBe(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it("1d は ちょうど 24 時間窓", () => {
    const r = resolvePresenceRange("1d", NOW);
    expect(NOW.getTime() - r.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("90d は 90 日窓", () => {
    const r = resolvePresenceRange("90d", NOW);
    expect(NOW.getTime() - r.from.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("all は from=エポック（全期間）", () => {
    const r = resolvePresenceRange("all", NOW);
    expect(r.from.getTime()).toBe(0);
    expect(r.label).toBe("全期間");
  });

  it("未知値は既定(7d)で解決", () => {
    const r = resolvePresenceRange("xxx", NOW);
    expect(r.key).toBe("7d");
  });

  it("from < to が常に成り立つ", () => {
    for (const k of PRESENCE_RANGE_KEYS) {
      const r = resolvePresenceRange(k, NOW);
      expect(r.from.getTime()).toBeLessThan(r.to.getTime());
    }
  });
});

describe("presenceRangeOptions", () => {
  it("5 プリセットを返し current のみ active", () => {
    const opts = presenceRangeOptions("30d");
    expect(opts).toHaveLength(5);
    expect(opts.filter((o) => o.active).map((o) => o.key)).toEqual(["30d"]);
    expect(opts.every((o) => o.label.length > 0)).toBe(true);
  });
});
