import { describe, expect, it } from "vitest";
import nextConfig, { NAMESPACE_REDIRECTS } from "../../next.config";

/**
 * namespace 改称 (経路設計実装設計書 §4.1/§42.5) の旧 URL 温存リダイレクトを pin する。
 *
 * next.config の `redirects()` は build 時に焼き込まれユニット/CI では実機まで露見しないため
 * ([[permissions-policy-disabled-feature]] と同型の盲点)、ここで mapping と段階導入の不変条件を固定する:
 *   ① 旧 `/admin/system/*` が運営 `/ops/*` へ (PR-1)、② 学校系 `/admin/<prefix>/*` が `/app/<prefix>/*` へ
 *   (PR-2: editor/school/contents/chat/teacher-input)、いずれも **308 (permanent)** で転送されること、
 *   ③ **段階導入の規律**: 未移設 (`/admin/account` 等) を飲み込む素の `/admin/:path*` catch-all を**まだ張らない**こと
 *      (張ると未移設パスへ 308 して 404 を生む。残りは PR-3 で実体移設と同時に catch-all へ集約)。
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

  it("学校系 /admin/<prefix>/* を /app/<prefix>/* へ 308 で恒久リダイレクトする (PR-2)", () => {
    // 移設済 5 prefix が 1:1 で /app に対応すること。
    for (const prefix of ["editor", "school", "contents", "chat", "teacher-input"]) {
      const r = NAMESPACE_REDIRECTS.find((x) => x.source === `/admin/${prefix}/:path*`);
      expect(r, `redirect for /admin/${prefix} 未配線`).toBeDefined();
      expect(r?.destination).toBe(`/app/${prefix}/:path*`);
      expect(r?.permanent).toBe(true);
    }
  });

  it("全エントリが permanent (308) で、source は旧 namespace・destination は新 namespace を指す", () => {
    expect(NAMESPACE_REDIRECTS.length).toBeGreaterThan(0);
    for (const r of NAMESPACE_REDIRECTS) {
      expect(r.permanent).toBe(true);
      expect(r.source.startsWith("/admin/")).toBe(true);
      expect(r.destination.startsWith("/ops") || r.destination.startsWith("/app")).toBe(true);
    }
  });

  it("段階導入: 素の /admin/:path* catch-all はまだ張らない (未移設 account/signage-preview 等を 404 にしない)", () => {
    // PR-1/PR-2 は移設済 prefix のみ。`/admin/:path*` (= /admin 直下の全てを飲む catch-all) を張ると、まだ
    // /admin 配下に残る account / signage-preview / dashboard / sensors / reports / tv-devices や /admin index への
    // GET が未移設先へ 308 され 404 になる。catch-all は実体移設が完了する PR-3 で初めて張る。
    // 不変条件: 全 source は `/admin/<prefix>/:path*` (3 セグメント以上) であり、素の `/admin/:path*` (2 セグメント) ではない。
    for (const r of NAMESPACE_REDIRECTS) {
      const segments = r.source.split("/").filter(Boolean); // 例: /admin/editor/:path* → ["admin","editor",":path*"]
      expect(
        segments.length,
        `${r.source} が素の /admin catch-all になっている`,
      ).toBeGreaterThanOrEqual(3);
      expect(segments[0]).toBe("admin");
      expect(segments[1]).not.toBe(":path*");
    }
  });
});
