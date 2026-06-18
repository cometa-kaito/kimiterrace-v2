import { describe, expect, it } from "vitest";
import { parseDeliveryPayload } from "../../lib/partner/delivery-payload";

/**
 * Phase5: K3 配信 payload の scope='monitor'（個別モニタ直指定）の検証。`parseDeliveryPayload` は pure
 * なので DB なしで検証する。monitor は scopeRef ではなく targetMonitorIds（tv_devices.id 集合）で対象指定し、
 * 空集合は恒久エラー（空配信防止）。非 monitor では targetMonitorIds を空配列に正規化する。
 */

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const MON_1 = "aaaaaaaa-1111-4111-8111-111111111111";
const MON_2 = "bbbbbbbb-2222-4222-8222-222222222222";

function payload(adFields: Record<string, unknown>) {
  return {
    advertiser: {
      portalCompanyId: UUID_A,
      companyName: "アクメ商事",
      industry: null,
      contactEmail: null,
      status: "active",
    },
    contract: null,
    ads: [
      {
        portalPlacementId: UUID_B,
        v2SchoolId: UUID_C,
        mediaType: "image",
        durationSec: 7,
        displayOrder: 1,
        assetFetchUrl: "https://example.com/a.png",
        linkUrl: null,
        ...adFields,
      },
    ],
  };
}

describe("parseDeliveryPayload: scope=monitor（Phase5）", () => {
  it("targetMonitorIds 付き monitor は受理（scopeRef 不要・targetMonitorIds 保持）", () => {
    const res = parseDeliveryPayload(
      payload({ scope: "monitor", targetMonitorIds: [MON_1, MON_2] }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.ads[0]?.scope).toBe("monitor");
      expect(res.value.ads[0]?.scopeRef).toBeNull();
      expect(res.value.ads[0]?.targetMonitorIds).toEqual([MON_1, MON_2]);
    }
  });

  it("monitor で targetMonitorIds 無し/空は恒久エラー（空配信防止）", () => {
    expect(parseDeliveryPayload(payload({ scope: "monitor" })).ok).toBe(false);
    expect(parseDeliveryPayload(payload({ scope: "monitor", targetMonitorIds: [] })).ok).toBe(
      false,
    );
  });

  it("monitor は scopeRef を要求しない（school/grade/class/department と異なる）", () => {
    const res = parseDeliveryPayload(
      payload({ scope: "monitor", targetMonitorIds: [MON_1], scopeRef: null }),
    );
    expect(res.ok).toBe(true);
  });

  it("targetMonitorIds に非 UUID が混ざると拒否", () => {
    expect(
      parseDeliveryPayload(payload({ scope: "monitor", targetMonitorIds: ["not-a-uuid"] })).ok,
    ).toBe(false);
  });

  it("非 monitor スコープでは targetMonitorIds は無視され空配列に正規化", () => {
    const res = parseDeliveryPayload(payload({ scope: "school", targetMonitorIds: [MON_1] }));
    expect(res.ok && res.value.ads[0]?.targetMonitorIds).toEqual([]);
  });
});
