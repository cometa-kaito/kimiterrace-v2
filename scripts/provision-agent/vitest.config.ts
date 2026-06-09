import { defineConfig } from "vitest/config";

/**
 * provision-agent の純粋ヘルパー単体テスト設定（PR5）。
 *
 * DB を一切使わない（packages/observability と同型）。lib.mjs は副作用ゼロの整形関数だけなので
 * 実 PostgreSQL も実 adb も不要 — node 環境で同期的に検証できる（ルール7、CI で確実に走る）。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
});
