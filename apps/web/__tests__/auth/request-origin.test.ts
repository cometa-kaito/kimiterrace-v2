import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 公開オリジン解決の検証 (リセットリンクの宛先 origin)。
 *
 * 核心 (PR #730 Reviewer High): 設定された正準 `NEXT_PUBLIC_APP_URL` を最優先し、詐称可能なヘッダに依存
 * しない。env 未設定時のみヘッダにフォールバックし、その際も host の形を検証して注入を弾く。
 */

const { getHeaders } = vi.hoisted(() => ({ getHeaders: vi.fn() }));
vi.mock("next/headers", () => ({ headers: () => getHeaders() }));

import {
  getRequestOrigin,
  normalizeConfiguredOrigin,
  originFromHeaders,
} from "../../lib/http/request-origin";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("originFromHeaders", () => {
  it("x-forwarded-host + x-forwarded-proto から組み立てる", () => {
    const h = new Headers({ "x-forwarded-host": "app.example", "x-forwarded-proto": "https" });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("x-forwarded-host を host より優先する (Cloud Run の内部 host を使わない)", () => {
    const h = new Headers({
      "x-forwarded-host": "app.example",
      host: "kimiterrace-web.run.app",
      "x-forwarded-proto": "https",
    });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("x-forwarded-host が無ければ host にフォールバック", () => {
    const h = new Headers({ host: "app.example", "x-forwarded-proto": "https" });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("proto 未指定は https を既定にする (公開は TLS 終端)", () => {
    const h = new Headers({ "x-forwarded-host": "app.example" });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("複数ホップ (カンマ区切り) は先頭の公開値を採る", () => {
    const h = new Headers({
      "x-forwarded-host": "app.example, internal.run.app",
      "x-forwarded-proto": "https, http",
    });
    expect(originFromHeaders(h)).toBe("https://app.example");
  });

  it("ポート付き host は許可する", () => {
    const h = new Headers({ "x-forwarded-host": "app.example:8443", "x-forwarded-proto": "https" });
    expect(originFromHeaders(h)).toBe("https://app.example:8443");
  });

  it("path / userinfo / 空白を含む不正形の host は null (生成リンクへの注入防止、非空虚)", () => {
    expect(originFromHeaders(new Headers({ "x-forwarded-host": "evil.com/path" }))).toBeNull();
    expect(originFromHeaders(new Headers({ "x-forwarded-host": "evil.com@good.com" }))).toBeNull();
    expect(originFromHeaders(new Headers({ "x-forwarded-host": "ho st" }))).toBeNull();
  });

  it("host が全く無ければ null (安全側でフォールバック可能に)", () => {
    expect(originFromHeaders(new Headers())).toBeNull();
  });
});

describe("normalizeConfiguredOrigin", () => {
  it("URL を proto://host に正規化し path を落とす", () => {
    expect(normalizeConfiguredOrigin("https://app.example/foo?x=1")).toBe("https://app.example");
  });

  it("空 / undefined / null は null", () => {
    expect(normalizeConfiguredOrigin("")).toBeNull();
    expect(normalizeConfiguredOrigin(undefined)).toBeNull();
    expect(normalizeConfiguredOrigin(null)).toBeNull();
  });

  it("URL として解析不能な値は null", () => {
    expect(normalizeConfiguredOrigin("not a url")).toBeNull();
  });
});

describe("getRequestOrigin (正準ソース優先)", () => {
  it("NEXT_PUBLIC_APP_URL があればヘッダを無視してそれを使う (詐称ヘッダ非依存、本 fix の核心)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://canonical.example/");
    // ヘッダに攻撃者ホストが乗っていても採用しない。
    getHeaders.mockResolvedValue(new Headers({ "x-forwarded-host": "evil.example" }));
    expect(await getRequestOrigin()).toBe("https://canonical.example");
  });

  it("env 未設定ならヘッダ (host 形検証つき) にフォールバックする", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    getHeaders.mockResolvedValue(
      new Headers({ "x-forwarded-host": "app.example", "x-forwarded-proto": "https" }),
    );
    expect(await getRequestOrigin()).toBe("https://app.example");
  });

  it("env 未設定 + headers() が throw (リクエストスコープ外) は null", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    getHeaders.mockRejectedValue(new Error("called outside a request scope"));
    expect(await getRequestOrigin()).toBeNull();
  });
});
