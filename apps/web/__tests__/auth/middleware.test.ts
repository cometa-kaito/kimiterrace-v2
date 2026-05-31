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
 * matcher 回帰 (PR #160 Reviewer Critical-1 / #48-E): 匿名公開経路を `__session` ゲートから
 * 除外できているかを matcher 正規表現で固定する。除外漏れると生徒/端末アクセスが /login に弾かれ
 * 実機破綻する。matcher は path 全体にマッチする想定なので ^...$ で anchor して判定する。
 */
describe("middleware matcher (匿名公開経路の除外)", () => {
  // biome-ignore lint/style/noNonNullAssertion: config.matcher は固定で存在する
  const gated = new RegExp(`^${config.matcher[0]!}$`);

  it("F05 匿名経路 /s/{token}・/student はゲート対象外 (除外)", () => {
    expect(gated.test("/s/abc123_token")).toBe(false);
    expect(gated.test("/student")).toBe(false);
  });

  it("F12/#48-E 公開サイネージ /signage/{classToken}(/data) はゲート対象外 (除外)", () => {
    expect(gated.test("/signage/abc123_token")).toBe(false);
    expect(gated.test("/signage/abc123_token/data")).toBe(false);
  });

  it("F12/#48-M フィードバック /guide・/api/guide/* はゲート対象外 (除外)", () => {
    expect(gated.test("/guide")).toBe(false);
    expect(gated.test("/api/guide/feedback")).toBe(false);
  });

  it("guide 除外は guide(?:/|$) で厳格、/guidelines 等は過剰除外しない (保護のまま)", () => {
    // `guide` 単体だと /guidelines も巻き込み静かな保護バイパスになる (PR #227 Reviewer Low-1)。
    expect(gated.test("/guidelines")).toBe(true);
    expect(gated.test("/guide-internal")).toBe(true);
  });

  it("login / student 除外も (?:/|$) で厳格、lookalike は過剰除外しない (保護のまま) (#139 L3)", () => {
    // login・student は leaf。anchor 無しだと /loginx・/studentx 等を巻き込み静かな under-protection。
    expect(gated.test("/loginx")).toBe(true);
    expect(gated.test("/students")).toBe(true);
    expect(gated.test("/student-portal")).toBe(true);
    // 正規の leaf アクセスは引き続き除外 (認証不要のまま)。
    expect(gated.test("/login")).toBe(false);
    expect(gated.test("/student")).toBe(false);
  });

  it("既存の認証不要パスも除外のまま", () => {
    expect(gated.test("/login")).toBe(false);
    expect(gated.test("/api/auth/session")).toBe(false);
    expect(gated.test("/api/auth/signout")).toBe(false);
    expect(gated.test("/api/health")).toBe(false);
  });

  it("api/auth 除外は api/auth/ で厳格、/api/authorize 等は過剰除外しない (保護のまま) (#139 L3)", () => {
    // anchor の無い `api/auth` だと /api/authorize 等を巻き込み、将来 /api/auth で始まる別ルートを
    // 追加した人が「保護されている」と誤認する静かなバイパスになる (PR #227 の guide と同クラス)。
    expect(gated.test("/api/authorize")).toBe(true);
    expect(gated.test("/api/auth-debug")).toBe(true);
  });

  it("api/health 除外は api/health(?:/|$) で厳格、/api/healthz 等は過剰除外しない (保護のまま) (#139 L3)", () => {
    // leaf エンドポイントなので完全一致 + 末尾スラッシュのみ除外。/api/healthz は保護対象に残す。
    expect(gated.test("/api/healthz")).toBe(true);
    expect(gated.test("/api/health-internal")).toBe(true);
    // 末尾スラッシュ付きの正規アクセスは引き続き除外 (認証不要のまま)。
    expect(gated.test("/api/health/")).toBe(false);
  });

  it("保護対象 (/admin 等) は引き続きゲート対象、s で始まる別パスは過剰除外しない", () => {
    expect(gated.test("/admin")).toBe(true);
    expect(gated.test("/dashboard")).toBe(true);
    // `s/` 除外が /settings を巻き込まないこと (s/ ではなく settings)
    expect(gated.test("/settings")).toBe(true);
  });

  it("signage/ 除外が認証必須の /admin/signage-preview を巻き込まない (過剰除外しない)", () => {
    // `/admin/...` 始まりは signage/ 除外の影響外 → 引き続きゲート対象 (保護される)。
    expect(gated.test("/admin/signage-preview/some-class-id")).toBe(true);
  });
});
