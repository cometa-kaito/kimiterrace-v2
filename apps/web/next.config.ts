import type { NextConfig } from "next";

/**
 * Next.js 設定。
 *
 * - `output: "standalone"` は Cloud Run 用の最小ランタイムを生成する。
 *   Dockerfile から `.next/standalone` をコピーして `node server.js` で起動する想定。
 * - 監視・テレメトリ系は `packages/observability` に分離予定（別 Issue）。
 * - `transpilePackages`: ワークスペース内パッケージ (@kimiterrace/db / @kimiterrace/ai /
 *   @kimiterrace/observability) は raw TS ソースを公開し、内部 re-export が `.js` 拡張子
 *   (NodeNext 互換) を使う。Next のバンドラはそのままでは解決できないため、production build グラフに
 *   入る workspace パッケージを列挙して Next の TS パイプラインで変換させる (Next monorepo の標準対応)。
 *   ai / observability は #154 の抽出トリガ route が production build に引き込むため追加 (PR #287)。
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@kimiterrace/db", "@kimiterrace/ai", "@kimiterrace/observability"],
};

export default nextConfig;
