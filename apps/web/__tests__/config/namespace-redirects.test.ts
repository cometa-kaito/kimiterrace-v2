import { describe, expect, it } from "vitest";
import nextConfig, { NAMESPACE_REDIRECTS } from "../../next.config";

/**
 * namespace 改称 (経路設計実装設計書 §4.1/§42.5) の旧 URL 温存リダイレクトを pin する。
 *
 * next.config の `redirects()` は build 時に焼き込まれユニット/CI では実機まで露見しないため
 * ([[permissions-policy-disabled-feature]] と同型の盲点)、ここで mapping と段階導入の不変条件を固定する:
 *   ① 旧 `/admin/system/*` が運営 `/ops/*` へ **308 (permanent)** で転送されること、
 *   ② **段階導入の規律**: まだ実体移設していない学校系 `/admin/*`→`/app/*` の catch-all を**まだ足さない**こと
 *      (足すと未移設パスへ 308 して 404 を生む。後続 PR で実体移設と同時に追加する)。
 * 旧→新の実遷移 (308・着地) は e2e (`e2e/namespace-redirects.spec.ts`) が実機検証する。
 */
describe("namespace 改称リダイレクト (§4.1/§42.5)", () => {
  it("redirects() が NAMESPACE_REDIRECTS をそのまま配線する", async () => {
    if (!nextConfig.redirects) throw new Error("next.config の redirects() が未定義");
    const redirects = await nextConfig.redirects();
    expect(redirects).toEqual([...NAMESPACE_REDIRECTS]);
  });

  it("旧 /admin/system/* を /ops/* へ 308 (permanent) で恒久リダイレクトする", () => {
    const sys = NAMESPACE_REDIRECTS.find((r) => r.source === "/admin/system/:path*");
    expect(sys).toBeDefined();
    expect(sys?.destination).toBe("/ops/:path*");
    // permanent:true = 308 (method 保持)。301 だと旧パス宛 POST が GET に落ちうるため使わない。
    expect(sys?.permanent).toBe(true);
  });

  it("全エントリが permanent (308) で、source は旧 namespace・destination は新 namespace を指す", () => {
    expect(NAMESPACE_REDIRECTS.length).toBeGreaterThan(0);
    for (const r of NAMESPACE_REDIRECTS) {
      expect(r.permanent).toBe(true);
      expect(r.source.startsWith("/admin/")).toBe(true);
      expect(r.destination.startsWith("/ops") || r.destination.startsWith("/app")).toBe(true);
    }
  });

  it("段階導入: 学校系 /admin/* → /app の catch-all はまだ配線しない (未移設パスを 404 にしないため)", () => {
    // PR-1 は /admin/system→/ops のみ。素の /admin/:path* catch-all (= /admin/system 以外も飲む) や /app 行きを
    // 先に足すと、まだ /admin 配下に残る editor/school/contents 等への GET が未移設先へ 308 され 404 になる。
    const prematureAppRedirect = NAMESPACE_REDIRECTS.some((r) => r.destination.startsWith("/app"));
    const prematureAdminCatchAll = NAMESPACE_REDIRECTS.some(
      (r) => r.source.startsWith("/admin/") && !r.source.startsWith("/admin/system"),
    );
    expect(prematureAppRedirect).toBe(false);
    expect(prematureAdminCatchAll).toBe(false);
  });
});
