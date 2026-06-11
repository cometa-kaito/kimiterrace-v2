import { describe, expect, it } from "vitest";
import {
  AD_MEDIA_ACCEPT,
  ALLOWED_AD_MEDIA_UPLOAD_TYPES,
  adUploadErrorMessage,
  resolveAdMediaUploadType,
} from "../../lib/ads/media-upload-validation";

/**
 * #46 / ADR-037: 広告メディアアップロード入力検証のユニットテスト。
 * 受理 MIME allowlist（本スライス＝画像のみ）と ext / media_type 導出、charset 揺れの正規化を pin する。
 */

describe("resolveAdMediaUploadType", () => {
  it("PNG / JPEG を受理し ext + media_type を導出する", () => {
    expect(resolveAdMediaUploadType("image/png")).toEqual({
      mime: "image/png",
      ext: "png",
      mediaType: "image",
    });
    expect(resolveAdMediaUploadType("image/jpeg")).toEqual({
      mime: "image/jpeg",
      ext: "jpg",
      mediaType: "image",
    });
  });

  it("charset 等のパラメータ・大小・前後空白を正規化して照合する", () => {
    expect(resolveAdMediaUploadType("IMAGE/PNG; charset=binary")?.ext).toBe("png");
    expect(resolveAdMediaUploadType("  image/jpeg  ")?.ext).toBe("jpg");
  });

  it("許可外（gif / pdf / 実行可能 / 本スライス未対応の video）は null", () => {
    expect(resolveAdMediaUploadType("image/gif")).toBeNull();
    expect(resolveAdMediaUploadType("application/pdf")).toBeNull();
    expect(resolveAdMediaUploadType("video/mp4")).toBeNull();
    expect(resolveAdMediaUploadType("")).toBeNull();
    expect(resolveAdMediaUploadType(null)).toBeNull();
  });

  it("allowlist は image のみ（media_type に video を含まない）", () => {
    expect(ALLOWED_AD_MEDIA_UPLOAD_TYPES.every((t) => t.mediaType === "image")).toBe(true);
    expect(AD_MEDIA_ACCEPT).toBe("image/png,image/jpeg");
  });
});

describe("adUploadErrorMessage", () => {
  it("status を管理者向け日本語に写像し、想定外は汎用文言にフォールバック", () => {
    expect(adUploadErrorMessage(401)).toContain("ログイン");
    expect(adUploadErrorMessage(403)).toContain("権限");
    expect(adUploadErrorMessage(413)).toContain("大きすぎ");
    expect(adUploadErrorMessage(415)).toContain("対応していない");
    expect(adUploadErrorMessage(502)).toContain("保存に失敗");
    expect(adUploadErrorMessage(418)).toBe("アップロードに失敗しました。");
  });
});
