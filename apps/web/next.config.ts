import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// monorepo ルート（apps/web から 2 つ上）。pnpm の複数 lockfile 誤検知を避けるため tracing root を明示する。
const monorepoRoot = fileURLToPath(new URL("../../", import.meta.url));

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
 * - `outputFileTracingRoot` / `outputFileTracingIncludes`: PDF 抽出器 (@kimiterrace/ai の PdfExtractor)
 *   は実行時に `pdfjs-dist/standard_fonts/` を **動的 `file://`** で読むが、Next の file-tracing (NFT) は
 *   動的アクセスを追えず standalone に同梱しない。同梱漏れすると標準フォント PDF の text 抽出がサイレントに
 *   空になるため、フォント実体を trace に明示追加する (Issue #311)。万一同梱漏れしても
 *   `instrumentation.ts` の起動時 assert が loud failure として検知する。
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@kimiterrace/db", "@kimiterrace/ai", "@kimiterrace/observability"],
  // pdfjs-dist はバンドルせず runtime に node_modules から require させる。バンドルすると
  // (a) PdfExtractor の `createRequire(import.meta.url).resolve("pdfjs-dist/package.json")` が
  // chunk 位置から解決できず standard_fonts を見失う、(b) legacy build の worker/font 資産が壊れる。
  // external 化 + apps/web の直接依存化で、server (next start) と standalone の双方で解決可能にする (#311)。
  serverExternalPackages: ["pdfjs-dist"],
  outputFileTracingRoot: monorepoRoot,
  outputFileTracingIncludes: {
    // 抽出 route は標準フォント PDF を扱う。pnpm の入れ子 (.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist) を
    // ワイルドカードで吸収する。`[id]` は glob のキャラクタクラス扱いになるため route キーは `/api/**` で広く取る。
    "/api/**": ["./node_modules/**/pdfjs-dist/standard_fonts/**"],
  },

  // 全ルートに多層防御のセキュリティレスポンスヘッダを付与する（live staging DAST 検証で全欠落を検出）。
  // 公立校生徒データを扱うため defense-in-depth を最小コストで足す。Cloud Run は HTTPS-only。
  // CSP は Firebase Auth / Next の inline を壊しうるため本 PR では入れず、report-only からの段階導入を別 follow-up。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // HTTPS 固定をブラウザに指示（ダウングレード / SSL strip 防止）。Cloud Run は HTTPS のみ。
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          // MIME sniffing 抑止（XSS 補助面を塞ぐ）。
          { key: "X-Content-Type-Options", value: "nosniff" },
          // クリックジャッキング対策。同一オリジン frame は許可（admin の signage-preview 等）。
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Referrer 漏洩を最小化（クロスオリジンには origin のみ送出）。
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // 不要なブラウザ機能を無効化（本 app は camera / microphone / geolocation を使わない）。
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
