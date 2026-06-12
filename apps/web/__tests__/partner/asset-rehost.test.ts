import type { Storage } from "@google-cloud/storage";
import { describe, expect, it, vi } from "vitest";
import {
  AssetPolicyError,
  AssetRehostError,
  assertPublicHttpsTarget,
  createGcsAssetRehost,
} from "@/lib/partner/asset-rehost";

/**
 * SSRF ガード `assertPublicHttpsTarget`（PR #816 Reviewer B-1）の単体テスト。
 *
 * `assetFetchUrl` は外部 portal 由来の値をサーバー側で fetch するシンク。Cloud Run のメタデータサーバ
 * （`169.254.169.254` / `metadata.google.internal`）から Workload Identity の SA トークンを盗む HIGH severity
 * SSRF になりうるため、**https 限定 + 内部ホスト/IP リテラル + 解決済み IP（DNS-rebinding）+ 空解決**を
 * 恒久拒否（`AssetPolicyError`）し、DNS 解決自体の失敗のみ transient（`AssetRehostError`）とする。
 */

/** 公開 IP（example.com）に解決する既定 lookup。 */
const publicLookup = async (): Promise<Array<{ address: string }>> => [
  { address: "93.184.216.34" },
];

describe("assertPublicHttpsTarget (SSRF ガード)", () => {
  it("https の公開ホスト → URL を返す", async () => {
    const url = await assertPublicHttpsTarget("https://cdn.example.com/a.png?t=1", publicLookup);
    expect(url.hostname).toBe("cdn.example.com");
  });

  it("http（非 https）→ AssetPolicyError（DNS せず恒久拒否）", async () => {
    const lookup = vi.fn(publicLookup);
    await expect(
      assertPublicHttpsTarget("http://cdn.example.com/a.png", lookup),
    ).rejects.toBeInstanceOf(AssetPolicyError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("メタデータ IP リテラル 169.254.169.254 → AssetPolicyError（DNS/fetch せず）", async () => {
    const lookup = vi.fn(publicLookup);
    await expect(
      assertPublicHttpsTarget("https://169.254.169.254/computeMetadata/v1/", lookup),
    ).rejects.toBeInstanceOf(AssetPolicyError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("metadata.google.internal → AssetPolicyError", async () => {
    await expect(
      assertPublicHttpsTarget("https://metadata.google.internal/x", publicLookup),
    ).rejects.toBeInstanceOf(AssetPolicyError);
  });

  it("IPv6 loopback [::1] → AssetPolicyError", async () => {
    await expect(assertPublicHttpsTarget("https://[::1]/x", publicLookup)).rejects.toBeInstanceOf(
      AssetPolicyError,
    );
  });

  it("公開名が内部 IP へ解決（DNS-rebinding）→ AssetPolicyError", async () => {
    const lookup = async (): Promise<Array<{ address: string }>> => [{ address: "10.0.0.5" }];
    await expect(
      assertPublicHttpsTarget("https://evil.example.com/a.png", lookup),
    ).rejects.toBeInstanceOf(AssetPolicyError);
  });

  it("解決結果が空 → AssetPolicyError", async () => {
    const lookup = async (): Promise<Array<{ address: string }>> => [];
    await expect(
      assertPublicHttpsTarget("https://cdn.example.com/a.png", lookup),
    ).rejects.toBeInstanceOf(AssetPolicyError);
  });

  it("DNS 解決失敗 → AssetRehostError（transient・再送で回復しうる）", async () => {
    const lookup = async (): Promise<Array<{ address: string }>> => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      assertPublicHttpsTarget("https://cdn.example.com/a.png", lookup),
    ).rejects.toBeInstanceOf(AssetRehostError);
  });

  it("URL として不正 → AssetPolicyError", async () => {
    await expect(assertPublicHttpsTarget("not a url", publicLookup)).rejects.toBeInstanceOf(
      AssetPolicyError,
    );
  });
});

/**
 * 再ホスト本体（ADR-037）: 保存キーは `ads/partner/<objectId>`（配信 Route の受理条件 `ads/` 始まり）、
 * 返却 URL は **同一オリジン相対パス** `/ad-media/<key>`。サイネージ実機は県教委 Wi-Fi の FQDN 許可リスト下で
 * `app.school-signage.net` のみ到達可のため、`storage.googleapis.com` 直 URL を返してはならない（回帰防止）。
 */
describe("createGcsAssetRehost (同一オリジン再ホスト・ADR-037)", () => {
  /** 保存呼び出しを記録する Storage モック。 */
  function makeStorageMock() {
    const save = vi.fn(async () => undefined);
    const file = vi.fn(() => ({ save }));
    const bucket = vi.fn(() => ({ file }));
    return { storage: { bucket } as unknown as Storage, file, save };
  }

  const okFetch = (async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;

  // bytes [1,2,3] の sha256 先頭 16 hex（内容アドレスキーの期待値）
  const CONTENT_DIGEST = "039058c6f2c0cb49";

  it("保存キー=ads/partner/<id>-<内容hash>・返却=同一オリジン /ad-media/<key>（GCS 直 URL を返さない）", async () => {
    const { storage, file } = makeStorageMock();
    const rehost = createGcsAssetRehost({
      bucket: "ad-media-test",
      storage,
      fetchImpl: okFetch,
      lookupImpl: publicLookup,
    });

    const url = await rehost.rehost(
      "https://cdn.example.com/a.png",
      "11112222-3333-4444-5555-666677778888",
    );

    const expectedKey = `ads/partner/11112222-3333-4444-5555-666677778888-${CONTENT_DIGEST}`;
    expect(file).toHaveBeenCalledWith(expectedKey);
    expect(url).toBe(`/ad-media/${expectedKey}`);
    expect(url).not.toContain("storage.googleapis.com");
  });

  it("内容が変わるとキー（=URL）が変わる: 差し替えが immutable キャッシュを自然にバストする", async () => {
    const { storage, file } = makeStorageMock();
    const fetchV2 = (async () =>
      new Response(new Uint8Array([9, 9, 9]), {
        status: 200,
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    const rehost = createGcsAssetRehost({
      bucket: "ad-media-test",
      storage,
      fetchImpl: fetchV2,
      lookupImpl: publicLookup,
    });

    const url = await rehost.rehost(
      "https://cdn.example.com/b.png",
      "11112222-3333-4444-5555-666677778888",
    );

    expect(url).not.toBe(
      `/ad-media/ads/partner/11112222-3333-4444-5555-666677778888-${CONTENT_DIGEST}`,
    );
    expect(file).toHaveBeenCalledTimes(1);
  });

  it("objectId に path injection（`..`・`/`）→ AssetPolicyError（fetch 前に拒否）", async () => {
    const { storage, save } = makeStorageMock();
    const fetchSpy = vi.fn(okFetch);
    const rehost = createGcsAssetRehost({
      bucket: "ad-media-test",
      storage,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      lookupImpl: publicLookup,
    });

    await expect(
      rehost.rehost("https://cdn.example.com/a.png", "../escape"),
    ).rejects.toBeInstanceOf(AssetPolicyError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("取得が 200 以外 → AssetRehostError（transient・再送可能）", async () => {
    const { storage } = makeStorageMock();
    const rehost = createGcsAssetRehost({
      bucket: "ad-media-test",
      storage,
      fetchImpl: (async () => new Response("expired", { status: 403 })) as unknown as typeof fetch,
      lookupImpl: publicLookup,
    });

    await expect(
      rehost.rehost("https://cdn.example.com/a.png", "11112222-3333-4444-5555-666677778888"),
    ).rejects.toBeInstanceOf(AssetRehostError);
  });
});
