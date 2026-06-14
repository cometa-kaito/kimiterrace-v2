import { describe, expect, it } from "vitest";
import { parseDeliveryPayload } from "../../lib/partner/delivery-payload";

/**
 * 運営整理 §4「(無題の広告) 修正」: K3 配信 payload の `title`（portal 素材タイトル＝広告名）を
 * `caption` に流用する正規化（ユーザー判断 2026-06-14: ads に title 専用列は持たず caption に一本化）。
 * `parseDeliveryPayload` は pure なので DB なしで検証する。caption 優先 / title フォールバック / 両 null を固定。
 */

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

/** title / caption だけ差し替え可能な最小 valid payload を組む（その他は固定の有効値）。 */
function payloadWith(adFields: { title?: unknown; caption?: unknown }) {
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
        scope: "school",
        scopeRef: null,
        mediaType: "image",
        durationSec: 7,
        displayOrder: 1,
        assetFetchUrl: "https://example.com/asset.png",
        linkUrl: null,
        ...adFields,
      },
    ],
  };
}

describe("parseDeliveryPayload: title→caption 流用", () => {
  it("caption 未指定でも title があれば caption に採用される", () => {
    const res = parseDeliveryPayload(payloadWith({ title: "夏期講習キャンペーン" }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.ads[0]?.caption).toBe("夏期講習キャンペーン");
    }
  });

  it("caption が明示指定されていれば title より優先される", () => {
    const res = parseDeliveryPayload(payloadWith({ caption: "短い説明", title: "素材タイトル" }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.ads[0]?.caption).toBe("短い説明");
    }
  });

  it("title も caption も無ければ caption は null（PDF が「(無題の広告)」に倒す）", () => {
    const res = parseDeliveryPayload(payloadWith({}));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.ads[0]?.caption).toBeNull();
    }
  });

  it("title の前後空白はトリムされ、空文字は null 扱い（caption も無ければ null）", () => {
    const trimmed = parseDeliveryPayload(payloadWith({ title: "  余白あり  " }));
    expect(trimmed.ok && trimmed.value.ads[0]?.caption).toBe("余白あり");
    const empty = parseDeliveryPayload(payloadWith({ title: "   " }));
    expect(empty.ok && empty.value.ads[0]?.caption).toBeNull();
  });

  it("title が 60 文字超は恒久エラー（payload 拒否）", () => {
    const res = parseDeliveryPayload(payloadWith({ title: "あ".repeat(61) }));
    expect(res.ok).toBe(false);
  });
});
