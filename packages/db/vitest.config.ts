import { defineConfig } from "vitest/config";

/**
 * Vitest 設定。RLS テストは Testcontainers で実 PostgreSQL を起動するため、
 * Docker pull / 起動の時間を見込んで timeout を長めに取る (ADR-012)。
 *
 * - globalSetup: 1 度だけコンテナを起動 → 全テストで再利用 → 最後に teardown
 * - singleFork: テストファイル間で接続プールを共有
 */
export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    globalSetup: ["./__tests__/_helpers/global-setup.ts"],
  },
});
