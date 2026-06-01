import { describe, expect, it } from "vitest";
import { canonicalizeMac, parsePresenceWebhook } from "../../lib/sensors/switchbot";

describe("F13 SwitchBot payload 検証・正規化 (#408)", () => {
  it("canonicalizeMac: 区切りの有無を同一正規形（大文字・区切り無し）に揃える", () => {
    expect(canonicalizeMac("aa:bb:cc:dd:ee:01")).toBe("AABBCCDDEE01");
    expect(canonicalizeMac("aa-bb-cc-dd-ee-01")).toBe("AABBCCDDEE01");
    expect(canonicalizeMac("AABBCCDDEE01")).toBe("AABBCCDDEE01");
  });

  it("正常 payload を最小集合へ正規化する", () => {
    // nowMs を timeOfSample と同値に固定し、時刻窓（#437 Low-1）に左右されず正規化のみ検証する。
    const r = parsePresenceWebhook(
      {
        eventType: "changeReport",
        eventVersion: "1",
        context: {
          deviceType: "WoPresence",
          deviceMac: "aa:bb:cc:dd:ee:01",
          detectionState: "DETECTED",
          timeOfSample: 1700000000000,
        },
      },
      1700000000000,
    );
    expect(r).toEqual({
      deviceMac: "AABBCCDDEE01",
      detectionState: "DETECTED",
      timeOfSampleMs: 1700000000000,
      eventVersion: "1",
    });
  });

  it("detectionState は大文字化される", () => {
    expect(
      parsePresenceWebhook({ context: { deviceMac: "x1", detectionState: "detected" } })
        ?.detectionState,
    ).toBe("DETECTED");
  });

  it("timeOfSample 欠如は null（受信時刻にフォールバック）", () => {
    expect(parsePresenceWebhook({ context: { deviceMac: "x1" } })?.timeOfSampleMs).toBe(null);
  });

  it("context / deviceMac 欠如・非オブジェクトは null（呼出側で ignore）", () => {
    expect(parsePresenceWebhook({})).toBe(null);
    expect(parsePresenceWebhook({ context: {} })).toBe(null);
    expect(parsePresenceWebhook(null)).toBe(null);
    expect(parsePresenceWebhook("garbage")).toBe(null);
    expect(parsePresenceWebhook({ context: { deviceMac: "" } })).toBe(null);
  });

  it("負の timeOfSample は不正として弾く", () => {
    expect(parsePresenceWebhook({ context: { deviceMac: "x1", timeOfSample: -5 } })).toBe(null);
  });
});

// 決定論的な受信時刻（epoch ms）と便宜定数。
const NOW = 1_780_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

/** context を組んだ最小 webhook body。 */
function makeBody(ctx: Record<string, unknown>) {
  return { eventType: "changeReport", eventVersion: "1", context: ctx };
}

describe("F13 parsePresenceWebhook — Low-1 時刻窓 (#437)", () => {
  it("窓内（過去 1 日 / 未来 1 分 / 境界ちょうど +5min・-7d / 受信時刻）は timeOfSample を保持", () => {
    for (const t of [NOW - DAY, NOW + MIN, NOW + 5 * MIN, NOW - 7 * DAY, NOW]) {
      const r = parsePresenceWebhook(makeBody({ deviceMac: "AABBCCDDEE01", timeOfSample: t }), NOW);
      expect(r?.timeOfSampleMs).toBe(t);
    }
  });

  it("未来 5 分超は時刻注入とみなし null 化（検知 event 自体は保持）", () => {
    const r = parsePresenceWebhook(
      makeBody({
        deviceMac: "AABBCCDDEE01",
        detectionState: "DETECTED",
        timeOfSample: NOW + 6 * MIN,
      }),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r?.timeOfSampleMs).toBeNull(); // 受信時刻 fallback
    expect(r?.detectionState).toBe("DETECTED"); // 検知は捨てない
  });

  it("過去 7 日超は時刻注入とみなし null 化", () => {
    const r = parsePresenceWebhook(
      makeBody({ deviceMac: "AABBCCDDEE01", timeOfSample: NOW - 7 * DAY - MIN }),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r?.timeOfSampleMs).toBeNull();
  });
});

describe("F13 parsePresenceWebhook — Low-3 入力長上限 (#437)", () => {
  it("detectionState が 64 字超なら弾く（null）、64 字ちょうどは許容", () => {
    expect(
      parsePresenceWebhook(
        makeBody({ deviceMac: "AABBCCDDEE01", detectionState: "D".repeat(65) }),
        NOW,
      ),
    ).toBeNull();
    const ok = "D".repeat(64);
    expect(
      parsePresenceWebhook(makeBody({ deviceMac: "AABBCCDDEE01", detectionState: ok }), NOW)
        ?.detectionState,
    ).toBe(ok);
  });

  it("deviceMac が 64 字超なら弾く（null）", () => {
    expect(parsePresenceWebhook(makeBody({ deviceMac: "A".repeat(65) }), NOW)).toBeNull();
  });
});
