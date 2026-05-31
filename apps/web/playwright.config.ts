import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e 基盤 (F0 #48-O 第 1 増分)。
 *
 * **本増分のスコープは「基盤確立」のみ**。スモークは DB / 認証に依存しない `/login`
 * ページの描画 1 本だけ。DB seed と「ログイン→エディタ更新→サイネージ反映」golden path
 * は後続増分で追加する (本ファイル / CI には Postgres service をまだ足さない)。
 *
 * **webServer**: dev サーバーより安定する本番ビルドを起動する。`pnpm build && pnpm start`
 * を Playwright が管理し、`/login` が 200 を返すまで待つ。
 *
 * **DB 非依存**: `/login` は middleware の matcher 除外対象で、Server 側で `getDb()` を
 * 呼ばない (client SDK サインインのみ)。よって DATABASE_URL 無しでも起動・描画する。
 * 万一ビルド/起動が DATABASE_URL を要求しても、下記 env のダミー値は明らかな placeholder で
 * あり実接続は発生しない (CLAUDE.md ルール5: 実シークレットは置かない)。
 */
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
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
      // /login は Server で DB を呼ばないため接続は発生しない。ビルド/起動時の
      // 環境変数読み取りに備えた明らかな placeholder (CLAUDE.md ルール5)。
      DATABASE_URL: "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder",
    },
  },
});
