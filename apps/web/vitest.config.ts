import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // React 19 の自動 JSX ランタイム (react/jsx-runtime) で .tsx を変換する。
  esbuild: { jsx: "automatic" },
  // 本体コードと同じ `@/*` エイリアス (tsconfig paths) をテストでも解決する。
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    // setupFiles は両プロジェクト共有 (jest-dom matchers + afterEach cleanup。node 側は DOM が無く no-op)。
    setupFiles: ["./vitest.setup.ts"],
    // `environmentMatchGlobs` は vitest 3 で deprecated・4 で削除のため `projects` に移行する (#357)。
    // 拡張子で環境を分離: サーバーロジックの .test.ts は node、React コンポーネントの .test.tsx は jsdom。
    // 各プロジェクトは root の vite 設定 (esbuild.jsx / resolve.alias) と test 設定 (setupFiles) を
    // `extends: true` で継承する。`*.test.ts` glob は `*.test.tsx` にマッチしないので二重実行はしない。
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["__tests__/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["__tests__/**/*.test.tsx"],
        },
      },
    ],
  },
});
