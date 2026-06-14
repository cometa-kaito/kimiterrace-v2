import { expect, test } from "@playwright/test";

/**
 * namespace 改称 (経路設計実装設計書 §4.1/§42.5) の旧 URL 温存リダイレクトを実機検証する (PR-3 完了形)。
 *
 * 旧 `/admin/system/*` を運営 `/ops/*` へ、残る学校系 `/admin/*` (index 含む) を `/app/*` へ catch-all で物理改称
 * したのに伴い、`next.config.ts` の 308 redirect で旧 URL を温存する。本 spec は **未認証 navigation** でその 308 が
 * 効くことを確かめる:
 *   旧パスを開く → 308 で新 path に書き換わる → (未認証なので) middleware が `/login?next=<新path>` へ弾く。
 *   `next` の値が旧 path でなく新 path であることが、308 が **middleware より前段**で path を書き換えた証左
 *   (= 旧 URL のブックマークが新コンソールへ確実に転送される)。
 *
 * `/admin/system/*` が `/ops/*` (≠ `/app/system/*`) に着地することは、catch-all `/admin/:path*`→`/app` より
 * `/admin/system/:path*`→`/ops` が **前に評価される (first-match-wins)** ことの実機証明も兼ねる。
 *
 * DB / Auth emulator 非依存 (middleware の cookie 存在チェックだけで成立) なので CI で常時走る (skip しない)。
 * 認証済みで実ページに着地する経路は `authorization-matrix.spec.ts` (新パスを直接叩く) が担保する。
 */
test.describe("namespace 改称リダイレクト (§4.1/§42.5)", () => {
  // 認証クッキーを持たない状態で旧 URL を叩く (storageState を空にして storageState 依存の偽 green を防ぐ)。
  test.use({ storageState: { cookies: [], origins: [] } });

  // [旧 path, 期待される新 path] — :path* は 0 セグメント (素の親) にも一致することを併せて pin。
  const REDIRECTS: ReadonlyArray<readonly [string, string]> = [
    // 運営 → /ops。catch-all (/admin/:path*→/app) より前に評価されることの証明も兼ねる。
    ["/admin/system/schools", "/ops/schools"],
    ["/admin/system", "/ops"],
    // §43: tv-devices は /ops へ。旧 /admin/tv-devices も catch-all より前で /ops/tv-devices へ。
    ["/admin/tv-devices", "/ops/tv-devices"],
    ["/admin/tv-devices/abc123/edit", "/ops/tv-devices/abc123/edit"],
    // PR-3 で一時的に /app/tv-devices に着地していた分も /ops/tv-devices へ。
    ["/app/tv-devices", "/ops/tv-devices"],
    // 学校系中核 → /app。
    ["/admin/editor/abc123", "/app/editor/abc123"],
    ["/admin/school", "/app/school"],
    ["/admin/contents", "/app/contents"],
    ["/admin/chat", "/app/chat"],
    ["/admin/teacher-input", "/app/teacher-input"],
    // /app へ集約した残り (account/signage-preview/dashboard/sensors/reports) も catch-all で転送される。
    ["/admin/account/password", "/app/account/password"],
    ["/admin/signage-preview/abc123", "/app/signage-preview/abc123"],
    ["/admin/dashboard", "/app/dashboard"],
    ["/admin/sensors", "/app/sensors"],
    ["/admin/reports", "/app/reports"],
    // 素の /admin index も catch-all で /app (= role 別 home へ redirect する着地ページ) へ。
    ["/admin", "/app"],
  ];

  for (const [oldPath, newPath] of REDIRECTS) {
    test(`旧 ${oldPath} は ${newPath} へ 308 温存される`, async ({ page }) => {
      await page.goto(oldPath);
      // 308 → 新 path → 未認証 → middleware が /login?next=<新path> へ。
      await expect(page).toHaveURL(/\/login\?next=/);
      const next = new URL(page.url()).searchParams.get("next");
      expect(next).toBe(newPath);
    });
  }
});
