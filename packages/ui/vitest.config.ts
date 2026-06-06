import { defineConfig } from "vitest/config";

/**
 * `@kimiterrace/ui` のテスト設定。presentational コンポーネントのみなので jsdom 単一プロジェクト。
 * React 19 の自動 JSX ランタイムで .tsx を変換する（apps/web の vitest.config.ts と同方針）。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["__tests__/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
