import { describe, expect, it } from "vitest";
import nextConfig, { CONTENT_SECURITY_POLICY_REPORT_ONLY } from "../../next.config";

/**
 * #591 (Part of #243): CSP の **Report-Only 段階導入**スライスを pin する。
 *
 * next.config の `headers()` は build 時にレスポンスヘッダへ焼き込まれ、ユニット/CI では露見せず実機
 * （live curl / DAST）でしか検証できない（[[permissions-policy-disabled-feature]]）。そこで次の 2 点を
 * ここで固定する: ①ヘッダが **Report-Only**（非ブロッキング）として配線され enforce 版を**まだ付けない**こと、
 * ②ポリシー文字列が締めるべき directive を含み危険トークン/無制限ワイルドカードを含まないこと。
 * enforce（`Content-Security-Policy`）への昇格は staging で違反ゼロを確認してからの follow-up。
 */
describe("CSP Report-Only ヘッダ (#591)", () => {
  it("Report-Only として配線され、enforce 版ヘッダはまだ付けない（非ブロッキング段階導入）", async () => {
    if (!nextConfig.headers) throw new Error("next.config の headers() が未定義");
    const groups = await nextConfig.headers();
    const all = groups.flatMap((g) => g.headers);
    const keys = all.map((h) => h.key);
    expect(keys).toContain("Content-Security-Policy-Report-Only");
    // enforce 版はまだ配信しない（誤って enforce すると Firebase Auth / Next inline を壊しうる）。
    expect(keys).not.toContain("Content-Security-Policy");
    const csp = all.find((h) => h.key === "Content-Security-Policy-Report-Only");
    expect(csp?.value).toBe(CONTENT_SECURITY_POLICY_REPORT_ONLY);
  });

  it("即時に締められる高価値 directive を含む", () => {
    const p = CONTENT_SECURITY_POLICY_REPORT_ONLY;
    expect(p).toContain("default-src 'self'");
    expect(p).toContain("object-src 'none'");
    expect(p).toContain("base-uri 'self'");
    expect(p).toContain("frame-ancestors 'self'");
    expect(p).toContain("form-action 'self'");
  });

  it("media-src を明示する（signage 広告の <video> が default-src に落ちて enforce 時に見落とされるのを防ぐ）", () => {
    // signage の広告は外部 CDN の画像/動画（SignageClient の ad.mediaUrl）を表示する。media-src を明示して
    // おかないと <video> が default-src 'self' に falls back し、enforce 移行時に動画が黙って壊れる（Reviewer 指摘）。
    const directives = CONTENT_SECURITY_POLICY_REPORT_ONLY.split("; ");
    expect(directives.find((d) => d.startsWith("media-src"))).toContain("'self'");
  });

  it("connect-src は自オリジン + Firebase Auth(Identity Platform) に限定し、ワイルドカードを使わない", () => {
    const connect = CONTENT_SECURITY_POLICY_REPORT_ONLY.split("; ").find((d) =>
      d.startsWith("connect-src"),
    );
    expect(connect).toBeDefined();
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://identitytoolkit.googleapis.com");
    expect(connect).toContain("https://securetoken.googleapis.com");
    expect(connect).toContain("https://www.googleapis.com");
    // データ持ち出し面を広げないため connect-src に無制限ワイルドカードを置かない。
    expect(connect).not.toContain("https://*");
    expect(connect).not.toMatch(/\s\*(\s|$)/);
  });

  it("Report-Only 段階は Next inline 用に script/style の 'unsafe-inline' を許容する（enforce 前に nonce へ締める）", () => {
    const directives = CONTENT_SECURITY_POLICY_REPORT_ONLY.split("; ");
    expect(directives.find((d) => d.startsWith("script-src"))).toContain("'unsafe-inline'");
    expect(directives.find((d) => d.startsWith("style-src"))).toContain("'unsafe-inline'");
  });

  it("危険なトークンを含まない（unsafe-eval / 主要 fetch directive のグローバル *）", () => {
    const p = CONTENT_SECURITY_POLICY_REPORT_ONLY;
    expect(p).not.toContain("unsafe-eval");
    // default-src / script-src / connect-src に丸ごとの '*'（全許可）を入れない。
    expect(p).not.toMatch(/(default|script|connect)-src[^;]*\s\*(\s|;|$)/);
  });
});
