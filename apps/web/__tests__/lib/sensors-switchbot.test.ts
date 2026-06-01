import { describe, expect, it } from "vitest";
import { canonicalizeMac, parsePresenceWebhook } from "../../lib/sensors/switchbot";

describe("F13 SwitchBot payload 検証・正規化 (#408)", () => {
  it("canonicalizeMac: 区切りの有無を同一正規形（大文字・区切り無し）に揃える", () => {
    expect(canonicalizeMac("aa:bb:cc:dd:ee:01")).toBe("AABBCCDDEE01");
    expect(canonicalizeMac("aa-bb-cc-dd-ee-01")).toBe("AABBCCDDEE01");
    expect(canonicalizeMac("AABBCCDDEE01")).toBe("AABBCCDDEE01");
  });

  it("正常 payload を最小集合へ正規化する", () => {
    const r = parsePresenceWebhook({
      eventType: "changeReport",
      eventVersion: "1",
      context: {
        deviceType: "WoPresence",
        deviceMac: "aa:bb:cc:dd:ee:01",
        detectionState: "DETECTED",
        timeOfSample: 1700000000000,
      },
    });
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
