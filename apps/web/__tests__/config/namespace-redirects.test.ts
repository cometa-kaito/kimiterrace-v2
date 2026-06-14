import { describe, expect, it } from "vitest";
import nextConfig, { NAMESPACE_REDIRECTS } from "../../next.config";

/**
 * namespace 改称 (経路設計実装設計書 §4.1/§42.5) の旧 URL 温存リダイレクトを pin する (PR-3 完了形)。
 *
 * next.config の `redirects()` は build 時に焼き込まれユニット/CI では実機まで露見しないため
 * ([[permissions-policy-disabled-feature]] と同型の盲点)、ここで mapping と順序の不変条件を固定する:
 *   ① 旧 `/admin/system/*` が運営 `/ops/*` へ、② 残る学校系 `/admin/*` (index 含む) が `/app/*` へ catch-all で、
 *      いずれも **308 (permanent)** で転送されること、
 *   ③ **順序**: `/admin/system` ルールが `/admin` catch-all より **前** にあること (first-match-wins。逆順だと
 *      `/admin/system/*` が catch-all に飲まれ `/app/system/*` へ 308 して 404 になる)。
 * 旧→新の実遷移 (308・着地) は e2e (`e2e/namespace-redirects.spec.ts`) が実機検証する。
 */
describe("namespace 改称リダイレクト (§4.1/§42.5)", () => {
  it("redirects() が NAMESPACE_REDIRECTS をそのまま配線する", async () => {
    if (!nextConfig.redirects) throw new Error("next.config の redirects() が未定義");
    const redirects = await nextConfig.redirects();
    expect(redirects).toEqual([...NAMESPACE_REDIRECTS]);
  });

  it("旧 /admin/system/* を /ops/* へ 308 (permanent) で恒久リダイレクトする (PR-1)", () => {
    const sys = NAMESPACE_REDIRECTS.find((r) => r.source === "/admin/system/:path*");
    expect(sys).toBeDefined();
    expect(sys?.destination).toBe("/ops/:path*");
    // permanent:true = 308 (method 保持)。301 だと旧パス宛 POST が GET に落ちうるため使わない。
    expect(sys?.permanent).toBe(true);
  });

  it("残る学校系 /admin/* を /app/* へ catch-all で 308 集約する (PR-3)", () => {
    // 素の /admin/:path* catch-all (index + account/signage-preview/dashboard/sensors/reports/
    // editor/school/contents/chat/teacher-input を一括) が /app/:path* へ。:path* は 0 セグメントにも一致。
    const catchAll = NAMESPACE_REDIRECTS.find((r) => r.source === "/admin/:path*");
    expect(catchAll, "/admin catch-all 未配線").toBeDefined();
    expect(catchAll?.destination).toBe("/app/:path*");
    expect(catchAll?.permanent).toBe(true);
  });

  it("§43: tv-devices は /ops へ。旧 /admin/tv-devices と一時的 /app/tv-devices の両方を /ops/tv-devices へ 308", () => {
    const fromAdmin = NAMESPACE_REDIRECTS.find((r) => r.source === "/admin/tv-devices/:path*");
    expect(fromAdmin, "/admin/tv-devices 未配線").toBeDefined();
    expect(fromAdmin?.destination).toBe("/ops/tv-devices/:path*");
    expect(fromAdmin?.permanent).toBe(true);
    const fromApp = NAMESPACE_REDIRECTS.find((r) => r.source === "/app/tv-devices/:path*");
    expect(fromApp, "/app/tv-devices 未配線").toBeDefined();
    expect(fromApp?.destination).toBe("/ops/tv-devices/:path*");
    expect(fromApp?.permanent).toBe(true);
  });

  it("全エントリが permanent (308) で、source は旧 namespace・destination は新 namespace を指す", () => {
    expect(NAMESPACE_REDIRECTS.length).toBeGreaterThan(0);
    for (const r of NAMESPACE_REDIRECTS) {
      expect(r.permanent).toBe(true);
      // source は旧 /admin/* か、§43 で再移設した一時的 /app/tv-devices。
      expect(r.source.startsWith("/admin") || r.source.startsWith("/app")).toBe(true);
      expect(r.destination.startsWith("/ops") || r.destination.startsWith("/app")).toBe(true);
    }
  });

  it("順序: 具体 prefix (/admin/system・/admin/tv-devices → /ops) は /admin catch-all (→ /app) より前 (first-match-wins)", () => {
    // 逆順だと /admin/system/schools や /admin/tv-devices が /admin/:path* に先に飲まれ /app/... (存在しない) へ 308 → 404。
    const catchAllIdx = NAMESPACE_REDIRECTS.findIndex((r) => r.source === "/admin/:path*");
    expect(catchAllIdx).toBeGreaterThanOrEqual(0);
    for (const specific of ["/admin/system/:path*", "/admin/tv-devices/:path*"]) {
      const idx = NAMESPACE_REDIRECTS.findIndex((r) => r.source === specific);
      expect(idx, `${specific} が未配線`).toBeGreaterThanOrEqual(0);
      expect(idx, `${specific} は /admin catch-all より前であるべき`).toBeLessThan(catchAllIdx);
    }
  });
});
