import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../lib/auth/session";
import { toAdsActor, validateAdInput } from "../../lib/school-admin/ads-core";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("toAdsActor", () => {
  const base: AuthUser = { uid: "u1", role: "school_admin", schoolId: UUID };
  it("school_id があれば actor を返す", () => {
    expect(toAdsActor(base)).toEqual({ userId: "u1", schoolId: UUID });
  });
  it("school_id null (テナント未選択 system_admin 等) は null", () => {
    expect(toAdsActor({ ...base, role: "system_admin", schoolId: null })).toBeNull();
  });
});

describe("validateAdInput", () => {
  const valid = {
    mediaUrl: "https://cdn.example.com/a.png",
    mediaType: "image",
    durationSec: 8,
    captionFontScale: 1.3,
    displayOrder: 2,
  };

  it("正常: 既定値 (duration 30 / fontScale 1.0 / order 0 / caption,link null)", () => {
    const r = validateAdInput({ mediaUrl: "https://x.test/a.png", mediaType: "image" });
    expect(r).toEqual({
      ok: true,
      value: {
        mediaUrl: "https://x.test/a.png",
        mediaType: "image",
        durationSec: 30,
        linkUrl: null,
        caption: null,
        captionFontScale: 1.0,
        displayOrder: 0,
      },
    });
  });

  it("正常: 全項目指定 + caption/link trim", () => {
    const r = validateAdInput({ ...valid, caption: "  夏期講習 ", linkUrl: "https://x.test/lp" });
    expect(r.ok && r.value.caption).toBe("夏期講習");
    expect(r.ok && r.value.linkUrl).toBe("https://x.test/lp");
    expect(r.ok && r.value.mediaType).toBe("image");
  });

  it("mediaUrl 空 / 非 URL / 非 http(s) スキームは拒否", () => {
    expect(validateAdInput({ ...valid, mediaUrl: "" }).ok).toBe(false);
    expect(validateAdInput({ ...valid, mediaUrl: "not a url" }).ok).toBe(false);
    expect(validateAdInput({ ...valid, mediaUrl: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateAdInput({ ...valid, mediaUrl: "ftp://x.test/a.png" }).ok).toBe(false);
  });

  it("mediaType は image / video 以外を拒否", () => {
    expect(validateAdInput({ ...valid, mediaType: "gif" }).ok).toBe(false);
    expect(validateAdInput({ ...valid, mediaType: undefined }).ok).toBe(false);
    expect(validateAdInput({ ...valid, mediaType: "video" }).ok).toBe(true);
  });

  it("durationSec 境界: 0 / 301 / 非整数 は拒否、1 / 300 は許可", () => {
    expect(validateAdInput({ ...valid, durationSec: 0 }).ok).toBe(false);
    expect(validateAdInput({ ...valid, durationSec: 301 }).ok).toBe(false);
    expect(validateAdInput({ ...valid, durationSec: 5.5 }).ok).toBe(false);
    expect(validateAdInput({ ...valid, durationSec: 1 }).ok).toBe(true);
    expect(validateAdInput({ ...valid, durationSec: 300 }).ok).toBe(true);
  });

  it("durationSec 文字列の数値は受理", () => {
    const r = validateAdInput({ ...valid, durationSec: "12" });
    expect(r.ok && r.value.durationSec).toBe(12);
  });

  it("captionFontScale は 0.85/1.0/1.3/1.6 のみ許可、他は拒否", () => {
    for (const s of [0.85, 1.0, 1.3, 1.6]) {
      expect(validateAdInput({ ...valid, captionFontScale: s }).ok).toBe(true);
    }
    expect(validateAdInput({ ...valid, captionFontScale: 2.0 }).ok).toBe(false);
    expect(validateAdInput({ ...valid, captionFontScale: 1.1 }).ok).toBe(false);
  });

  it("caption 61 文字超は拒否、空文字は null", () => {
    expect(validateAdInput({ ...valid, caption: "あ".repeat(61) }).ok).toBe(false);
    const r = validateAdInput({ ...valid, caption: "" });
    expect(r.ok && r.value.caption).toBeNull();
  });

  it("linkUrl 指定時は http(s) URL 必須", () => {
    expect(validateAdInput({ ...valid, linkUrl: "javascript:void(0)" }).ok).toBe(false);
    const r = validateAdInput({ ...valid, linkUrl: "" });
    expect(r.ok && r.value.linkUrl).toBeNull();
  });

  it("displayOrder 負値 / 域外は拒否、未指定は 0", () => {
    expect(validateAdInput({ ...valid, displayOrder: -1 }).ok).toBe(false);
    expect(validateAdInput({ ...valid, displayOrder: 40000 }).ok).toBe(false);
  });
});
