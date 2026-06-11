import { describe, expect, it, vi } from "vitest";
import {
  AssetPolicyError,
  AssetRehostError,
  assertPublicHttpsTarget,
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
