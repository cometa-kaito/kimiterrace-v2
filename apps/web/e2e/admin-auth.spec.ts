import { expect, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE, isSignageDbAvailable } from "./global-setup";

/**
 * 認証 golden-path e2e の **増分 1** (F0 #48-O 第 3 増分): 教員ログイン到達。
 *
 * `auth.setup.ts` が Auth emulator + 実 `/api/auth/session` 経由で作った教員の `__session` を
 * storageState で再利用し、保護エリア `/admin` に到達する。teacher は `homePathForRole` で
 * `/admin/editor` にリダイレクトされ、**認証済みでないと描画されない要素** (ヘッダの role バッジ
 * 「教員」、エディタ着地の見出し) が見えること、および教員はサイドバー（メニュー）が撤去され全幅
 * であることを検証する。
 *
 * これは middleware (cookie 存在) → requireRole (claims 検証 / 401・403) →
 * AppShell (role 別 nav) → withSession (RLS スコープ) を貫く認証経路の end-to-end 証明。
 * editor 更新 → signage 反映の完全 golden path は**増分 2 (本 PR 対象外)**。
 */

// emulator / 実 DB が無いローカル実行では auth.setup が skip され storageState が無いので、本 spec も skip。
// CI (emulator + postgres service) では必ず実行される (偽 green 回避: skip 条件を実環境と一致させる)。
const authAvailable =
  !!process.env.FIREBASE_AUTH_EMULATOR_HOST && isSignageDbAvailable(process.env.DATABASE_URL);

test.describe("認証済み教員の管理エリア到達 /admin", () => {
  test.skip(!authAvailable, "FIREBASE_AUTH_EMULATOR_HOST 未設定 / DATABASE_URL placeholder");

  test.describe("ログイン済み (storageState 再利用)", () => {
    test.use({ storageState: TEACHER_STORAGE_STATE });

    test("教員は /admin からエディタに到達し認証済み要素が見える", async ({ page }) => {
      // /admin は teacher を homePathForRole で /admin/editor へリダイレクトする。
      await page.goto("/admin");
      await expect(page).toHaveURL(/\/admin\/editor$/);

      // 認証済みでないと出ない要素:
      // 1. AppShell ヘッダの role バッジ「教員」(claims.role=teacher が解決できた証)。
      await expect(page.getByText("教員", { exact: true })).toBeVisible();
      // 2. エディタ着地の見出し (requireRole(EDITOR_ROLES) を通過した証)。
      await expect(page.getByRole("heading", { name: "編集するクラスを選ぶ" })).toBeVisible();
      // 3. 教員はナビが「エディタ」1 項目のみのため、AppShell がサイドバー（メインナビゲーション）を
      //    撤去して全幅にする（ユーザー指摘 2026-06-13）。サイドバーが存在しないことを pin する。
      await expect(page.getByRole("navigation", { name: "メインナビゲーション" })).toHaveCount(0);
    });
  });

  test.describe("未ログイン (storageState なし)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("未認証で /admin を開くと /login にリダイレクトされる", async ({ page }) => {
      await page.goto("/admin");
      // middleware が __session 無しを /login?next=... に弾く (認可ゲートの negative)。
      await expect(page).toHaveURL(/\/login(\?|$)/);
      // ログイン画面の見出し（ブランド刷新でロゴ画像 + 「ログイン」見出しに変更）。
      await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
    });
  });
});
