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

  it("session cookie 有り → 現在パスを x-kt-pathname リクエストヘッダに注入する (F11 MFA ゲートのループ防止用)", () => {
    // 純加算的: cookie 検証・redirect 判定は変えず、下流 layout が pathname を読めるヘッダだけ足す。
    const res = middleware(makeRequest("/admin/account/mfa", { withCookie: true }));
    expect(res.headers.get("location")).toBeNull(); // redirect しないことは不変
    // NextResponse.next({request:{headers}}) は注入ヘッダを x-middleware-request-* に反映する。
    expect(res.headers.get("x-middleware-request-x-kt-pathname")).toBe("/admin/account/mfa");
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

  it("F06 生徒チャット /api/student/chat はゲート対象外 (除外)", () => {
    // 生徒は `__session` を持たず httpOnly cookie `__student_session` で認証する匿名経路。
    // 除外しないと /login に弾かれチャット破綻。可否は route の resolveStudentSession が判定 (#371)。
    expect(gated.test("/api/student/chat")).toBe(false);
  });

  it("api/student/ 除外は末尾 / で境界済、look-alike な /api/students 等は過剰除外しない (保護のまま)", () => {
    // 将来の保護対象 API (例: 生徒一覧 /api/students) を静かにゲート対象外にしない。
    expect(gated.test("/api/students")).toBe(true);
    expect(gated.test("/api/student-records")).toBe(true);
  });

  it("F12/#48-E 公開サイネージ /signage/{classToken}(/data) はゲート対象外 (除外)", () => {
    expect(gated.test("/signage/abc123_token")).toBe(false);
    expect(gated.test("/signage/abc123_token/data")).toBe(false);
  });

  it("#46/ADR-037 公開広告メディア /ad-media/{key} はゲート対象外 (除外・拡張子非依存)", () => {
    // サイネージ端末は `__session` を持たない匿名公開経路。可否は route の isValidAdMediaKey が担う。
    expect(gated.test("/ad-media/ads/22222222-2222-2222-2222-222222222222/abc.png")).toBe(false);
    // 末尾拡張子除外に依存せず除外する（video=.mp4 や拡張子規約変更でも破綻しない）。
    expect(gated.test("/ad-media/ads/x/clip.mp4")).toBe(false);
    expect(gated.test("/ad-media/foo")).toBe(false);
  });

  it("ad-media/ 除外は末尾 / で境界済、look-alike な /ad-mediax 等は過剰除外しない (保護のまま)", () => {
    expect(gated.test("/ad-mediax")).toBe(true);
    expect(gated.test("/ad-media-admin")).toBe(true);
  });

  it("F12/#48-M フィードバック /guide・/api/guide/* はゲート対象外 (除外)", () => {
    expect(gated.test("/guide")).toBe(false);
    expect(gated.test("/api/guide/feedback")).toBe(false);
  });

  it("F15/F16 TV ポーリング /api/tv/* はゲート対象外 (除外)", () => {
    // 学校設置 TV は `__session` を持たない外部 origin。除外しないと /login に弾かれポーリング破綻。
    // 認可は route handler の共有シークレット検証 (TV_POLL_SECRET) が担う (ADR-022)。
    expect(gated.test("/api/tv/config")).toBe(false);
    expect(gated.test("/api/tv/heartbeat")).toBe(false);
  });

  it("api/tv/ 除外は末尾 / で境界済、look-alike な /api/tvm 等は過剰除外しない (保護のまま)", () => {
    expect(gated.test("/api/tvm")).toBe(true);
    expect(gated.test("/api/tv-admin")).toBe(true);
  });

  it("効果還元K1 portal↔v2 /api/partner/* はゲート対象外 (除外)", () => {
    // portal (Vercel) は `__session` を持たない外部 origin。除外しないと /login に弾かれ K1 破綻。
    // 認可は route handler の共有シークレット検証 (PARTNER_API_SECRET) が担う (partner-api-contract §1)。
    expect(gated.test("/api/partner/advertisers/abc-uuid/metrics")).toBe(false);
    expect(gated.test("/api/partner/advertisers/abc/metrics?ym=2026-05")).toBe(false);
  });

  it("api/partner/ 除外は末尾 / で境界済、look-alike な /api/partners 等は過剰除外しない (保護のまま)", () => {
    expect(gated.test("/api/partners")).toBe(true);
    expect(gated.test("/api/partner-admin")).toBe(true);
  });

  it("guide 除外は guide(?:/|$) で厳格、/guidelines 等は過剰除外しない (保護のまま)", () => {
    // `guide` 単体だと /guidelines も巻き込み静かな保護バイパスになる (PR #227 Reviewer Low-1)。
    expect(gated.test("/guidelines")).toBe(true);
    expect(gated.test("/guide-internal")).toBe(true);
  });

  it("パスワード設定/リセット /reset-password はゲート対象外 (除外)", () => {
    // 利用者は未ログインで発行リンクから開くため除外必須。可否は client SDK の oobCode 検証が担う。
    expect(gated.test("/reset-password")).toBe(false);
  });

  it("reset-password 除外は reset-password(?:/|$) で厳格、look-alike /reset-passwords 等は過剰除外しない", () => {
    expect(gated.test("/reset-passwords")).toBe(true);
    expect(gated.test("/reset-password-internal")).toBe(true);
  });

  it("既存の認証不要パスも除外のまま (bare とサブパスの両方)", () => {
    expect(gated.test("/login")).toBe(false);
    expect(gated.test("/student")).toBe(false);
    expect(gated.test("/api/auth/session")).toBe(false);
    expect(gated.test("/api/auth/signout")).toBe(false);
    expect(gated.test("/api/health")).toBe(false);
  });

  it("境界厳格化 (#139 L3): prefix 一致だった token が look-alike な保護ルートを過剰除外しない", () => {
    // 素の `login`/`student`/`api/auth`/`api/health` は前方一致なので、これらが将来の
    // 保護対象ルートを静かにゲート対象外にしていた。`(?:/|$)` 境界化で gate 対象に戻す。
    expect(gated.test("/loginland")).toBe(true);
    expect(gated.test("/students")).toBe(true); // 生徒一覧のような保護ルートを想定
    expect(gated.test("/student-records")).toBe(true);
    expect(gated.test("/api/authority")).toBe(true);
    expect(gated.test("/api/auth-admin")).toBe(true);
    expect(gated.test("/api/healthcheck")).toBe(true);
    expect(gated.test("/api/health-internal")).toBe(true);
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
