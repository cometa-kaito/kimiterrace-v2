import { expect, test } from "@playwright/test";

/**
 * e2e スモーク (F0 #48-O 第 1 増分)。
 *
 * Playwright 基盤が成立している = 本番ビルドが起動し、DB / 認証に依存しない
 * `/login` ページが描画される、ことだけを検証する 1 本。golden path
 * (ログイン→エディタ更新→サイネージ反映) は後続増分で追加する。
 *
 * セレクタは apps/web/app/login/page.tsx の実在要素を使う:
 * - 見出し `<h1>ログイン</h1>`（ブランド刷新でロゴ画像 + 「ログイン」見出しに変更）
 * - 送信ボタン `ログイン`
 */
test("/login が DB なしで描画される (基盤スモーク)", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ログイン" })).toBeVisible();
});
