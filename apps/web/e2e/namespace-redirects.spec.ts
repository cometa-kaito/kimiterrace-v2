import { expect, test } from "@playwright/test";

/**
 * namespace 改称 (経路設計実装設計書 §4.1/§42.5) の旧 URL 温存リダイレクトを実機検証する。
 *
 * 旧 `/admin/system/*` を運営 `/ops/*` へ (PR-1)、旧 `/admin/<prefix>/*` を学校 `/app/<prefix>/*` へ (PR-2:
 * editor/school/contents/chat/teacher-input) 物理改称したのに伴い、`next.config.ts` の 308 redirect で旧 URL を
 * 温存する。本 spec は **未認証 navigation** でその 308 が効くことを確かめる:
 *   旧パスを開く → 308 で新 path に書き換わる → (未認証なので) middleware が `/login?next=<新path>` へ弾く。
 *   `next` の値が旧 path でなく新 path であることが、308 が **middleware より前段**で path を書き換えた証左
 *   (= 旧 URL のブックマークが新コンソールへ確実に転送される)。
 *
 * DB / Auth emulator 非依存 (middleware の cookie 存在チェックだけで成立) なので CI で常時走る (skip しない)。
 * 認証済みで実ページに着地する経路は `authorization-matrix.spec.ts` (新パスを直接叩く) が担保する。
 */
test.describe("namespace 改称リダイレクト (§4.1/§42.5)", () => {
  // 認証クッキーを持たない状態で旧 URL を叩く (storageState を空にして storageState 依存の偽 green を防ぐ)。
  test.use({ storageState: { cookies: [], origins: [] } });

  // [旧 path, 期待される新 path] — :path* は 0 セグメント (素の親) にも一致することを併せて pin。
  const REDIRECTS: ReadonlyArray<readonly [string, string]> = [
    // PR-1: 運営・配信コンソール。
    ["/admin/system/schools", "/ops/schools"],
    ["/admin/system", "/ops"],
    // PR-2: 学校コンソール中核 (5 prefix)。
    ["/admin/editor/abc123", "/app/editor/abc123"],
    ["/admin/school", "/app/school"],
    ["/admin/contents", "/app/contents"],
    ["/admin/chat", "/app/chat"],
    ["/admin/teacher-input", "/app/teacher-input"],
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

  test("未移設 /admin/account は 308 されない (段階導入: catch-all をまだ張らない)", async ({
    page,
  }) => {
    // account は PR-3 まで /admin 残置。素の /admin catch-all を誤って張ると /app/account へ 308 され 404 になる。
    // 未認証で開くと redirect されず /login?next=/admin/account に弾かれる (= 旧パスのまま保護されている) こと。
    await page.goto("/admin/account/password");
    await expect(page).toHaveURL(/\/login\?next=/);
    const next = new URL(page.url()).searchParams.get("next");
    expect(next).toBe("/admin/account/password");
  });
});
