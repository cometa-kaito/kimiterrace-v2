import { defineConfig } from "vitest/config";

/**
 * Vitest 設定 (RLS / トリガを実 PostgreSQL に対して検証する)。
 *
 * - 実 DB 接続が必要なため `globalSetup` で DDL + RLS migration を流し込む。
 * - 接続先は `DATABASE_URL` 環境変数。CI では postgres service コンテナ、
 *   ローカルでは docker-compose dev DB を利用する想定。
 *   `DATABASE_URL` 未設定の場合は globalSetup 内でテスト自体をスキップする
 *   (= testcontainers 等の自動起動はあえてしない、運用環境のばらつきを避ける)。
 *
 * ## TRUNCATE 衝突防止 (Issue #96 H2)
 *
 * `seedBaseFixture` (`__tests__/_setup/db.ts`) は冒頭で 18 テーブルを TRUNCATE する。
 * 複数 test ファイルが同時に走ると TRUNCATE 後の INSERT が他ファイルの SELECT と
 * 競合し data race / flaky test を生む。これを防ぐため:
 *
 *  1. `fileParallelism: false`: ファイル間並列を禁止
 *  2. `pool: 'forks'` + `poolOptions.forks.singleFork: true`:
 *     全テストファイルを単一 forked process で逐次実行 (Vitest 2.x 公式推奨パターン)
 *
 * 将来 fileParallelism を true に変えるなら、test ごとに独自 schema or savepoint
 * へ移行する必要がある (work expansion 大、Issue 化の上で別途検討)。
 */
export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globalSetup: ["./__tests__/_setup/global-setup.ts"],
    setupFiles: ["./__tests__/_setup/setup.ts"],
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
