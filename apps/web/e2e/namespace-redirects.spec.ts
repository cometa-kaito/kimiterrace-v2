import { expect, test } from "@playwright/test";

/**
 * namespace 改称 (経路設計実装設計書 §4.1/§42.5) の旧 URL 温存リダイレクトを実機検証する。
 *
 * 旧 `/admin/system/*` を運営 `/ops/*` へ物理改称したのに伴い、`next.config.ts` の 308 redirect で旧 URL を
 * 温存する。本 spec は **未認証 navigation** でその 308 が効くことを確かめる:
 *   旧パスを開く → 308 で `/ops/*` に書き換わる → (未認証なので) middleware が `/login?next=/ops/*` へ弾く。
 *   `next` の値が旧 `/admin/system/*` でなく新 `/ops/*` であることが、308 が **middleware より前段**で path を
 *   書き換えた証左 (= 旧 URL のブックマークが新コンソールへ確実に転送される)。
 *
 * DB / Auth emulator 非依存 (middleware の cookie 存在チェックだけで成立) なので CI で常時走る (skip しない)。
 * 認証済みで実ページに着地する経路は `authorization-matrix.spec.ts` (新パスを直接叩く) が担保する。
 */
test.describe("namespace 改称リダイレクト /admin/system → /ops (§4.1/§42.5)", () => {
  // 認証クッキーを持たない状態で旧 URL を叩く (storageState を空にして storageState 依存の偽 green を防ぐ)。
  test.use({ storageState: { cookies: [], origins: [] } });

  test("旧 /admin/system/schools は /ops/schools へ 308 温存される", async ({ page }) => {
    await page.goto("/admin/system/schools");
    // 308 → /ops/schools → 未認証 → middleware が /login?next=/ops/schools へ。
    await expect(page).toHaveURL(/\/login\?next=/);
    const next = new URL(page.url()).searchParams.get("next");
    expect(next).toBe("/ops/schools");
  });

  test("旧 /admin/system (素・0 セグメント) は /ops へ 308 温存される", async ({ page }) => {
    // :path* が 0 個のセグメントにも一致することを pin (素の親パスも取りこぼさない)。
    await page.goto("/admin/system");
    await expect(page).toHaveURL(/\/login\?next=/);
    const next = new URL(page.url()).searchParams.get("next");
    expect(next).toBe("/ops");
  });
});
