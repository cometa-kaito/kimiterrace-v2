import type { NextConfig } from "next";

/**
 * Next.js 設定。
 *
 * - `output: "standalone"` は Cloud Run 用の最小ランタイムを生成する。
 *   Dockerfile から `.next/standalone` をコピーして `node server.js` で起動する想定。
 * - 監視・テレメトリ系は `packages/observability` に分離予定（別 Issue）。
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
