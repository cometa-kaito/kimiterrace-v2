import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `@/*` を tsconfig paths と同じ解決にする (本体とテスト共通)。
const alias = { "@": fileURLToPath(new URL(".", import.meta.url)) };

// vitest 3 deprecation 対応 (#357): `environmentMatchGlobs` を撤去し
// `test.projects` で .test.ts (node) と .test.tsx (jsdom) を分離。
// vitest 4 で environmentMatchGlobs が削除されてもブロックされない。
export default defineConfig({
  // React 19 の自動 JSX ランタイム (react/jsx-runtime) で .tsx を変換する。
  esbuild: { jsx: "automatic" },
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["__tests__/**/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["__tests__/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
