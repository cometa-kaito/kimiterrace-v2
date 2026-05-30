import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, middleware } from "../../middleware";

/**
 * middleware.ts の redirect 分岐 unit テスト。
 *
 * middleware は Edge での「cookie 存在チェックのみ」(ADR-003)。実検証は Server 側。
 * ここでは cookie の有無で next() / redirect(/login) が切り替わることだけを検証する。
 */

function makeRequest(path: string, opts: { withCookie?: boolean } = {}): NextRequest {
  const req = new NextRequest(new URL(`https://app.example${path}`));
  if (opts.withCookie) {
    req.cookies.set("__session", "some-cookie-value");
  }
  return req;
}

describe("middleware", () => {
  it("session cookie 無し → /login へ redirect (元の path を next= に載せる)", () => {
    const res = middleware(makeRequest("/dashboard"));
    expect(res.status).toBe(307); // NextResponse.redirect の既定
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location as string);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/dashboard");
  });

  it("session cookie 有り → そのまま通す (redirect しない)", () => {
    const res = middleware(makeRequest("/dashboard", { withCookie: true }));
    // NextResponse.next() は redirect ヘッダを持たない (200 系で素通り)。
    expect(res.headers.get("location")).toBeNull();
  });

  it("クエリ付き path も next= に保持される", () => {
    const res = middleware(makeRequest("/reports?month=2026-05"));
    const url = new URL(res.headers.get("location") as string);
    expect(url.searchParams.get("next")).toBe("/reports?month=2026-05");
  });
});

/**
 * matcher 回帰 (PR #160 Reviewer Critical-1): F05 の匿名 2 経路を `__session` ゲートから
 * 除外できているかを matcher 正規表現で固定する。除外漏れると生徒アクセスが /login に弾かれ
 * 実機破綻する。matcher は path 全体にマッチする想定なので ^...$ で anchor して判定する。
 */
describe("middleware matcher (F05 匿名経路の除外)", () => {
  // biome-ignore lint/style/noNonNullAssertion: config.matcher は固定で存在する
  const gated = new RegExp(`^${config.matcher[0]!}$`);

  it("F05 匿名経路 /s/{token}・/student はゲート対象外 (除外)", () => {
    expect(gated.test("/s/abc123_token")).toBe(false);
    expect(gated.test("/student")).toBe(false);
  });

  it("既存の認証不要パスも除外のまま", () => {
    expect(gated.test("/login")).toBe(false);
    expect(gated.test("/api/auth/session")).toBe(false);
    expect(gated.test("/api/health")).toBe(false);
  });

  it("保護対象 (/admin 等) は引き続きゲート対象、s で始まる別パスは過剰除外しない", () => {
    expect(gated.test("/admin")).toBe(true);
    expect(gated.test("/dashboard")).toBe(true);
    // `s/` 除外が /settings を巻き込まないこと (s/ ではなく settings)
    expect(gated.test("/settings")).toBe(true);
  });
});
