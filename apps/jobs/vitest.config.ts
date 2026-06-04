import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // トラック⑤ MIG: 合成移行 dry-run 用の実 PG スキーマ初期化 (DATABASE_URL 設定時のみ実行)。
    // 共有 packages/db の globalSetup には触れず自前で初期化する (test-strategy §6.1 schema-token 回避)。
    globalSetup: ["./src/migration/__tests__/_setup/global-setup.ts"],
  },
});
