import type { NextConfig } from "next";

/**
 * Next.js 設定。
 *
 * - `output: "standalone"` は Cloud Run 用の最小ランタイムを生成する。
 *   Dockerfile から `.next/standalone` をコピーして `node server.js` で起動する想定。
 * - 監視・テレメトリ系は `packages/observability` に分離予定（別 Issue）。
 * - `transpilePackages`: ワークスペース内パッケージ (@kimiterrace/db) は raw TS ソースを
 *   公開し、内部 re-export が `.js` 拡張子 (NodeNext 互換) を使う。Next のバンドラはそのままでは
 *   解決できないため、列挙して Next の TS パイプラインで変換させる (Next monorepo の標準対応)。
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@kimiterrace/db"],
};

export default nextConfig;
