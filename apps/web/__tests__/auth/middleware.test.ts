import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "../../middleware";

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
