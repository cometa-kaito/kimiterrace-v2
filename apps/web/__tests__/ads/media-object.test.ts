import { describe, expect, it } from "vitest";
import {
  AD_MEDIA_OBJECT_PREFIX,
  adMediaServingPath,
  buildAdMediaObjectKey,
  isValidAdMediaKey,
} from "../../lib/ads/media-object";

/**
 * #46 / ADR-037: 広告メディアのオブジェクトキー検証と同一オリジン配信パスのユニットテスト。
 * 配信 Route とアップロード受口が共有する単一ソースの規約（接頭辞・安全文字・traversal 拒否）を pin する。
 */

describe("isValidAdMediaKey", () => {
  it("接頭辞 ads/ 配下の安全なキーを許可する", () => {
    expect(isValidAdMediaKey("ads/22222222-2222-2222-2222-222222222222/abc.png")).toBe(true);
    expect(isValidAdMediaKey("ads/file.jpg")).toBe(true);
    expect(isValidAdMediaKey("ads/a/b/c-d_e.mp4")).toBe(true);
  });

  it("接頭辞 ads/ で始まらないキーを拒否する（汎用バケットプロキシ化を防ぐ）", () => {
    expect(isValidAdMediaKey("uploads/secret.pdf")).toBe(false);
    expect(isValidAdMediaKey("reports/2026/05/x.pdf")).toBe(false);
    expect(isValidAdMediaKey("ads")).toBe(false); // 接頭辞のみ・実ファイル無し
  });

  it("path traversal（..）・空セグメント・先頭/末尾スラッシュを拒否する", () => {
    expect(isValidAdMediaKey("ads/../uploads/secret.pdf")).toBe(false);
    expect(isValidAdMediaKey("ads/./x.png")).toBe(false);
    expect(isValidAdMediaKey("ads//x.png")).toBe(false);
    expect(isValidAdMediaKey("/ads/x.png")).toBe(false);
    expect(isValidAdMediaKey("ads/x.png/")).toBe(false);
  });

  it("安全文字以外（スペース・クエリ・%・日本語等）を拒否する", () => {
    expect(isValidAdMediaKey("ads/a b.png")).toBe(false);
    expect(isValidAdMediaKey("ads/x.png?foo=1")).toBe(false);
    expect(isValidAdMediaKey("ads/%2e%2e/x")).toBe(false);
    expect(isValidAdMediaKey("ads/広告.png")).toBe(false);
  });

  it("空文字・非文字列・超長は拒否する", () => {
    expect(isValidAdMediaKey("")).toBe(false);
    expect(isValidAdMediaKey(undefined)).toBe(false);
    expect(isValidAdMediaKey(null)).toBe(false);
    expect(isValidAdMediaKey(123)).toBe(false);
    expect(isValidAdMediaKey(`ads/${"a".repeat(600)}.png`)).toBe(false);
  });

  it("接頭辞定数は 'ads'", () => {
    expect(AD_MEDIA_OBJECT_PREFIX).toBe("ads");
  });
});

describe("adMediaServingPath", () => {
  it("キーを同一オリジン配信パス /ad-media/<key> に変換する", () => {
    expect(adMediaServingPath("ads/abc/def.png")).toBe("/ad-media/ads/abc/def.png");
  });
});

describe("buildAdMediaObjectKey", () => {
  const SCHOOL = "22222222-2222-2222-2222-222222222222";
  const OBJ = "33333333-3333-3333-3333-333333333333";

  it("ads/<schoolId>/<objectId>.<ext> を組み立て、生成キーは isValidAdMediaKey を満たす", () => {
    const key = buildAdMediaObjectKey(SCHOOL, OBJ, "png");
    expect(key).toBe(`ads/${SCHOOL}/${OBJ}.png`);
    expect(isValidAdMediaKey(key)).toBe(true);
  });

  it("各要素に区切り文字が混入すると RangeError（prefix 境界跨ぎを防ぐ）", () => {
    expect(() => buildAdMediaObjectKey("a/b", OBJ, "png")).toThrow(RangeError);
    expect(() => buildAdMediaObjectKey(SCHOOL, "a/b", "png")).toThrow(RangeError);
    expect(() => buildAdMediaObjectKey(SCHOOL, OBJ, "p/g")).toThrow(RangeError);
    expect(() => buildAdMediaObjectKey(SCHOOL, OBJ, "pn.g")).toThrow(RangeError);
  });

  it("空要素は RangeError", () => {
    expect(() => buildAdMediaObjectKey("", OBJ, "png")).toThrow(RangeError);
    expect(() => buildAdMediaObjectKey(SCHOOL, "", "png")).toThrow(RangeError);
    expect(() => buildAdMediaObjectKey(SCHOOL, OBJ, "")).toThrow(RangeError);
  });
});
