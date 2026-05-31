import { defineConfig, devices } from "@playwright/test";
import { toAppDatabaseUrl } from "./e2e/global-setup";

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
 *   - webServer は `toAppDatabaseUrl(...)` で **kimiterrace_app (非 BYPASSRLS) 接続**にする (#213)。
 *     migrate / seed は globalSetup が superuser で行うが、描画経路はアプリロールで走らせて
 *     **RLS を実際に効かせる** (superuser のままだと RLS がバイパスされ end-to-end が名ばかりになる)。
 *   - CI は postgres service の URL を渡し (signage 描画まで RLS 下で検証)、未設定のローカルでは
 *     明らかな placeholder を渡す (この場合 signage spec は globalSetup 側で skip され /login のみ走る)。
 *     実シークレットはコード/設定に置かない (placeholder は localhost の自明値)。
 */
const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

// 実 DB があれば kimiterrace_app に差し替えて継承 (CI / ローカル PG)、無ければ placeholder。
const DATABASE_URL =
  toAppDatabaseUrl(process.env.DATABASE_URL) ??
  "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";

/**
 * Auth emulator 用 env (#48-O 第 3 増分)。CI / ローカルで `firebase emulators:exec` 配下にいると
 * `FIREBASE_AUTH_EMULATOR_HOST` が立つ。これを webServer に伝播させると firebase-admin
 * (lib/auth/adminApp.ts) が **コード変更なし**で emulator を信頼し、createSessionCookie /
 * verifySessionCookie が emulator トークンで成立する。projectId は demo (実プロジェクト不要)。
 * emulator が無い場合は undefined を渡さない (webServer env は string のみ) ため、立っている時だけ載せる。
 */
const FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "demo-kimiterrace";

const emulatorEnv: Record<string, string> = FIREBASE_AUTH_EMULATOR_HOST
  ? {
      FIREBASE_AUTH_EMULATOR_HOST,
      GOOGLE_CLOUD_PROJECT,
    }
  : {};

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
    // 認証セットアップ (#48-O 第 3 増分)。emulator に教員を作成し /api/auth/session 経由で
    // __session を storageState に保存する。chromium はこれに依存して認証済み spec を再利用する。
    {
      name: "setup",
      testMatch: /.*\.setup\.ts$/,
    },
    {
      name: "chromium",
      // `*.setup.ts` は setup project 専用なので chromium のテスト探索からは除外する。
      testIgnore: /.*\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
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
      // emulator が立っていれば firebase-admin を emulator に向ける (認証 e2e、コード変更なし)。
      ...emulatorEnv,
    },
  },
});
