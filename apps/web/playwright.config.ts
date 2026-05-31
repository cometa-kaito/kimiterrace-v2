import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e 設定 (F0 #48-O)。
 *
 * **第 1 増分 (#205)**: 基盤確立。DB / 認証非依存の `/login` 描画スモーク 1 本。
 * **第 2 増分 (本変更)**: 公開サイネージ golden-path。`globalSetup` が CI Postgres を
 *   migrate + seed し、`signage.spec.ts` が `/signage/{token}` の描画を実ブラウザで検証する。
 *
 * **webServer**: dev サーバーより安定する本番ビルドを起動する。`pnpm build && pnpm start`
 * を Playwright が管理し、`/login` が 200 を返すまで待つ。
 *
 * **DATABASE_URL の扱い (CLAUDE.md ルール5)**:
 *   - `/login` スモークは middleware 除外 + Server で `getDb()` を呼ばないので DB 不要。
 *   - `/signage/{token}` は Server で `getDb()` を呼ぶため **実 DB 接続が要る**。
 *   - そこで webServer には `process.env.DATABASE_URL` を**そのまま継承**させる。CI は
 *     postgres service の URL を渡し (signage 描画まで検証)、未設定のローカルでは明らかな
 *     placeholder を渡す (この場合 signage spec は globalSetup 側で skip され、/login のみ走る)。
 *     実シークレットはコード/設定に置かない (placeholder は localhost の自明値)。
 */
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

// 実 DB があれば継承 (CI / ローカル PG)、無ければ /login スモーク用の明らかな placeholder。
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";

export default defineConfig({
  testDir: "./e2e",
  // globalSetup が webServer 起動前に migrate + seed する (#48-O 第 2 増分)。
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm build && pnpm start --port ${PORT}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // signage ページは Server で getDb() を呼ぶため実 DB URL を継承する (上記参照)。
      DATABASE_URL,
    },
  },
});
