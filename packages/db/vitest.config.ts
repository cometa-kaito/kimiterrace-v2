import { defineConfig } from "vitest/config";

/**
 * Vitest 設定 (RLS / トリガを実 PostgreSQL に対して検証する)。
 *
 * - 実 DB 接続が必要なため `globalSetup` で DDL + RLS migration を流し込む。
 * - 各テストは独立したスキーマ操作 (TRUNCATE 等) を行うため逐次実行 (fileParallelism: false)。
 * - 接続先は `DATABASE_URL` 環境変数。CI では postgres service コンテナ、
 *   ローカルでは docker-compose dev DB を利用する想定。
 *   `DATABASE_URL` 未設定の場合は globalSetup 内でテスト自体をスキップする
 *   (= testcontainers 等の自動起動はあえてしない、運用環境のばらつきを避ける)。
 */
export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globalSetup: ["./__tests__/_setup/global-setup.ts"],
    setupFiles: ["./__tests__/_setup/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
