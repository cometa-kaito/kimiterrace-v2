import { describe, expect, it } from "vitest";
import { canonicalizeMac, parsePresenceWebhook } from "../../lib/sensors/switchbot";

/**
 * F13 (#408, #437): SwitchBot Webhook ペイロード検証・正規化の単体テスト（純粋関数、DB 不要）。
 *
 * 既存挙動（MAC 正規化 / detectionState 大文字化 / null fallback）に加え、#437 のハードニングを pin:
 * - Low-1: `timeOfSample` の sane window（受信時刻から過去 7 日〜未来 5 分）外は時刻注入とみなし null 化
 * - Low-3: `detectionState` / `deviceMac` の `.max(64)` で過大入力を弾く
 */

/** 決定論的な受信時刻（2026-06-01T00:00:00Z 相当の epoch ms）。 */
const NOW = 1_780_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

/** context を組んだ最小 webhook body を作る。 */
function body(ctx: Record<string, unknown>, top: Record<string, unknown> = {}) {
  return { eventType: "changeReport", eventVersion: "1", context: ctx, ...top };
}

describe("canonicalizeMac", () => {
  it("区切り（: - 空白）を除去し大文字化する", () => {
    expect(canonicalizeMac("aa:bb:cc:dd:ee:ff")).toBe("AABBCCDDEEFF");
    expect(canonicalizeMac("aa-bb-cc-dd-ee-ff")).toBe("AABBCCDDEEFF");
    expect(canonicalizeMac(" aabbccddeeff ")).toBe("AABBCCDDEEFF");
  });
});

describe("parsePresenceWebhook — 基本正規化", () => {
  it("有効ペイロードを正規化フィールドに射影する", () => {
    const r = parsePresenceWebhook(
      body({ deviceMac: "aa:bb:cc:dd:ee:ff", detectionState: "detected", timeOfSample: NOW }),
      NOW,
    );
    expect(r).toEqual({
      deviceMac: "AABBCCDDEEFF",
      detectionState: "DETECTED",
      timeOfSampleMs: NOW,
      eventVersion: "1",
    });
  });

  it("detectionState は大文字化、未指定は null", () => {
    const r = parsePresenceWebhook(body({ deviceMac: "AABBCCDDEEFF" }), NOW);
    expect(r?.detectionState).toBeNull();
  });

  it("timeOfSample 未指定は null（受信時刻 fallback）", () => {
    const r = parsePresenceWebhook(body({ deviceMac: "AABBCCDDEEFF" }), NOW);
    expect(r?.timeOfSampleMs).toBeNull();
  });

  it("不正ペイロード（deviceMac 欠落）は null", () => {
    expect(parsePresenceWebhook(body({ detectionState: "DETECTED" }), NOW)).toBeNull();
    expect(parsePresenceWebhook({ context: {} }, NOW)).toBeNull();
    expect(parsePresenceWebhook(null, NOW)).toBeNull();
  });
});

describe("parsePresenceWebhook — Low-1 時刻窓", () => {
  it("窓内（過去 1 日 / 未来 1 分 / 境界ちょうど）は timeOfSample を保持", () => {
    for (const t of [NOW - DAY, NOW + MIN, NOW + 5 * MIN, NOW - 7 * DAY, NOW]) {
      const r = parsePresenceWebhook(body({ deviceMac: "AABBCCDDEEFF", timeOfSample: t }), NOW);
      expect(r?.timeOfSampleMs).toBe(t);
    }
  });

  it("未来 5 分超は時刻注入とみなし null 化（イベント自体は保持）", () => {
    const r = parsePresenceWebhook(
      body({ deviceMac: "AABBCCDDEEFF", detectionState: "DETECTED", timeOfSample: NOW + 6 * MIN }),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r?.timeOfSampleMs).toBeNull(); // 受信時刻 fallback
    expect(r?.detectionState).toBe("DETECTED"); // 検知は捨てない
  });

  it("過去 7 日超は時刻注入とみなし null 化", () => {
    const r = parsePresenceWebhook(
      body({ deviceMac: "AABBCCDDEEFF", timeOfSample: NOW - 7 * DAY - MIN }),
      NOW,
    );
    expect(r).not.toBeNull();
    expect(r?.timeOfSampleMs).toBeNull();
  });
});

describe("parsePresenceWebhook — Low-3 長さ上限", () => {
  it("detectionState が 64 字超なら弾く（null）", () => {
    const long = "D".repeat(65);
    expect(
      parsePresenceWebhook(body({ deviceMac: "AABBCCDDEEFF", detectionState: long }), NOW),
    ).toBeNull();
  });

  it("detectionState 64 字ちょうどは許容", () => {
    const ok = "D".repeat(64);
    const r = parsePresenceWebhook(body({ deviceMac: "AABBCCDDEEFF", detectionState: ok }), NOW);
    expect(r?.detectionState).toBe(ok);
  });

  it("deviceMac が 64 字超なら弾く（null）", () => {
    const longMac = "A".repeat(65);
    expect(parsePresenceWebhook(body({ deviceMac: longMac }), NOW)).toBeNull();
  });
});
