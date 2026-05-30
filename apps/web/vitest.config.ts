import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // React 19 の自動 JSX ランタイム (react/jsx-runtime) で .tsx を変換する。
  esbuild: { jsx: "automatic" },
  // 本体コードと同じ `@/*` エイリアス (tsconfig paths) をテストでも解決する。
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    // 既定は node (サーバーロジックの unit テスト)。React コンポーネントの .test.tsx だけ jsdom。
    environment: "node",
    environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
