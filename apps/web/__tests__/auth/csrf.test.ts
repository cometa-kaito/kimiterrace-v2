import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "../../lib/auth/csrf";

/**
 * lib/auth/csrf.ts (#139 L2) の unit テスト。
 *
 * 認証系 state-changing POST (login / signout) への CSRF 多層防御。Origin (無ければ Referer) の
 * ホストが到達ホスト (x-forwarded-host → host) と一致するかを判定する。
 *
 * 脅威モデル: ブラウザ起点のクロスサイト POST は必ず Origin を載せる (偽れない) → mismatch で拒否。
 * 非ブラウザクライアント (Origin/Referer なし) は ambient cookie CSRF の媒介にならないため通す。
 */

const HOST = "app.example";

function req(headers: Record<string, string>): Request {
  return new Request("https://app.example/api/auth/session", {
    method: "POST",
    headers,
  });
}

describe("isSameOriginRequest", () => {
  it("Origin が到達ホスト (host) と一致 → true", () => {
    expect(isSameOriginRequest(req({ host: HOST, origin: "https://app.example" }))).toBe(true);
  });

  it("Origin がポート付きで host と一致 → true (ローカル開発)", () => {
    expect(
      isSameOriginRequest(req({ host: "localhost:3100", origin: "http://localhost:3100" })),
    ).toBe(true);
  });

  it("Origin が別ホスト (クロスサイト POST = CSRF) → false", () => {
    expect(isSameOriginRequest(req({ host: HOST, origin: "https://evil.example" }))).toBe(false);
  });

  it("x-forwarded-host を host より優先して突合する (Cloud Run/GCLB)", () => {
    // GCLB は公開ホストを x-forwarded-host に載せる。内部 host (Cloud Run の *.run.app) ではなく
    // 公開ホストと Origin を突合する。
    expect(
      isSameOriginRequest(
        req({
          host: "service-xxxx.a.run.app",
          "x-forwarded-host": HOST,
          origin: "https://app.example",
        }),
      ),
    ).toBe(true);
  });

  it("x-forwarded-host 優先のため、host が一致しても x-forwarded-host と不一致なら false", () => {
    expect(
      isSameOriginRequest(
        req({
          host: HOST,
          "x-forwarded-host": "real.example",
          origin: "https://app.example",
        }),
      ),
    ).toBe(false);
  });

  it("到達ホスト (host も x-forwarded-host も) 不在 → false (突合不能、安全側)", () => {
    // Request は通常 host を持つが、欠落時は deny に倒す。
    const r = new Request("https://app.example/api/auth/session", { method: "POST" });
    r.headers.delete("host");
    expect(isSameOriginRequest(r)).toBe(false);
  });

  it("Origin が在るが unparseable → false (Referer へフォールスルーしない)", () => {
    expect(
      isSameOriginRequest(req({ host: HOST, origin: "garbage", referer: "https://app.example/x" })),
    ).toBe(false);
  });

  it("Origin が 'null' (sandboxed iframe / opaque origin) → false (login CSRF 回避を塞ぐ)", () => {
    expect(
      isSameOriginRequest(req({ host: HOST, origin: "null", referer: "https://app.example/x" })),
    ).toBe(false);
  });

  it("Origin 無し + Referer が同一ホスト → true (Referer フォールバック)", () => {
    expect(isSameOriginRequest(req({ host: HOST, referer: "https://app.example/login" }))).toBe(
      true,
    );
  });

  it("Origin 無し + Referer が別ホスト → false", () => {
    expect(isSameOriginRequest(req({ host: HOST, referer: "https://evil.example/x" }))).toBe(false);
  });

  it("Origin も Referer も無い (非ブラウザ API クライアント) → true", () => {
    // Playwright APIRequestContext / server-to-server。e2e の POST /api/auth/session を壊さない。
    expect(isSameOriginRequest(req({ host: HOST }))).toBe(true);
  });
});
