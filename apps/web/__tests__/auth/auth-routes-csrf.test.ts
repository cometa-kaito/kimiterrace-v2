import { describe, expect, it } from "vitest";
import { POST as sessionPOST } from "../../app/api/auth/session/route";
import { POST as signoutPOST } from "../../app/api/auth/signout/route";

/**
 * #139 L2: 認証系 POST (login / signout) に CSRF 同一オリジン突合が配線されていることを固定する。
 *
 * helper 単体 (csrf.test.ts) に加え、route が実際に `isSameOriginRequest` を呼んで
 * クロスサイト POST を 403 で弾くこと・同一オリジンは素通りすることを route レベルで pin する
 * (将来の refactor でガードが外れたら CI が検知する)。
 *
 * firebase-admin はモックしない: クロスサイトは検証前に 403、同一オリジンは「idToken 欠落で 400」
 * の経路を使うため、いずれも `createSessionCookie` (Identity Platform) に到達しない。
 */

const HOST = "app.example";

function post(body: unknown, headers: Record<string, string>): Request {
  return new Request(`https://${HOST}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/auth/session — CSRF (#139 L2)", () => {
  it("クロスサイト Origin → 403 (idToken 検証に進まない)", async () => {
    const res = await sessionPOST(
      post({ idToken: "whatever" }, { host: HOST, origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden_origin" });
  });

  it("同一オリジン → CSRF gate 通過 (idToken 欠落で 400、403 ではない)", async () => {
    const res = await sessionPOST(post({}, { host: HOST, origin: `https://${HOST}` }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "missing_id_token" });
  });

  it("非ブラウザ (Origin/Referer なし) → CSRF gate 通過 (e2e/server-to-server を壊さない)", async () => {
    const res = await sessionPOST(post({}, { host: HOST }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/signout — CSRF (#139 L2)", () => {
  function signoutReq(headers: Record<string, string>): Request {
    return new Request(`https://${HOST}/api/auth/signout`, { method: "POST", headers });
  }

  it("クロスサイト Origin → 403 (強制ログアウトを防ぐ)", async () => {
    const res = signoutPOST(signoutReq({ host: HOST, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden_origin" });
  });

  it("同一オリジン → 200 + __session を空で削除 (maxAge=0)", async () => {
    const res = signoutPOST(signoutReq({ host: HOST, origin: `https://${HOST}` }));
    expect(res.status).toBe(200);
    const cookie = res.cookies.get("__session");
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
  });
});
