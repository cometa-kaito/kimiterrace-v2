import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// monorepo ルート（apps/web から 2 つ上）。pnpm の複数 lockfile 誤検知を避けるため tracing root を明示する。
const monorepoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Content-Security-Policy（**Report-Only から段階導入**、#591 / Part of #243）。
 *
 * enforced CSP を盲目的に入れると Firebase Auth / Next の inline を壊しうるため、まず
 * `Content-Security-Policy-Report-Only` で配信する。**Report-Only は非ブロッキング**で、違反は
 * ブラウザ devtools console に報告されるだけで実機能を壊さない。live staging で auth フロー・各機能・
 * SSE（/api/student/chat）・signage を踏み、報告された違反を洗い出してから enforce（`Content-Security-Policy`）
 * へ昇格する（違反ゼロ確認は本 PR の範囲外＝ staging 観測の follow-up）。
 *
 * 各 directive の根拠:
 * - `default-src 'self'`: 既定は自オリジンのみ。
 * - `base-uri 'self'` / `object-src 'none'` / `frame-ancestors 'self'` / `form-action 'self'`:
 *   即時に締められる高価値 directive（base tag 注入 / プラグイン / クリックジャッキング / フォーム乗っ取り防止）。
 *   frame-ancestors は X-Frame-Options SAMEORIGIN の近代版で整合。
 * - `connect-src`: ブラウザの fetch/XHR/WebSocket 先を自オリジン + **Firebase Auth（Identity Platform）**の
 *   identitytoolkit / securetoken / www.googleapis.com に限定（lib/auth/clientApp.ts の firebase/auth SDK
 *   が叩く先、ADR-003）。これがデータ持ち出し面の本丸。Sentry browser SDK / GCS 直アクセス等が観測されたら
 *   staging 踏みで追加する。
 * - `img-src` / `media-src` / `font-src`: 自オリジン + inline(data:/blob:)。**signage の広告は外部 CDN の
 *   画像/動画**（`SignageClient` の `ad.mediaUrl` を `<img>`/`<video>` で表示）を読む。外部 CDN の画像・動画・
 *   GCS 等は Report-Only で違反として可視化し、enforce 前に必要な CDN オリジンだけ許可する。`media-src` を
 *   **明示**するのは、無いと `<video>` が `default-src 'self'` に落ちて違反種別が紛れ enforce 時に見落とす
 *   ため（Reviewer 指摘）。
 * - `script-src` / `style-src` に `'unsafe-inline'`: Next.js（App Router / SSR）はハイドレーション用の
 *   inline script / style を注入する。Report-Only 段階では inline を許可して**他の違反（connect 先・外部資産）に
 *   集中**し、enforce 前に nonce / hash / 'strict-dynamic' へ締める（#591 の enforce-prep。`'unsafe-eval'` は
 *   付けない＝必要なら staging 観測で判断）。
 *
 * 文字列は build 時にレスポンスヘッダへ焼き込まれる（再 build / redeploy で反映、live curl で検証）。
 * テスト容易性のため named export し、`__tests__` から directive を pin する（default export = Next 設定本体）。
 */
const CSP_REPORT_ONLY_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
] as const;

/** Report-Only CSP のヘッダ値（directive を `; ` で連結）。#591。 */
export const CONTENT_SECURITY_POLICY_REPORT_ONLY = CSP_REPORT_ONLY_DIRECTIVES.join("; ");

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
 *   ui は共通 UI プリミティブの JIT パッケージ (dist ビルド無し・exports が raw TS を指し Next が変換)。
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
  transpilePackages: [
    "@kimiterrace/db",
    "@kimiterrace/ai",
    "@kimiterrace/observability",
    "@kimiterrace/ui",
  ],
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
  // CSP は enforce すると Firebase Auth / Next の inline を壊しうるため、まず Report-Only で段階導入する（#591）。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // HTTPS 固定をブラウザに指示（ダウングレード / SSL strip 防止）。Cloud Run は HTTPS のみ。
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          // MIME sniffing 抑止（XSS 補助面を塞ぐ）。
          { key: "X-Content-Type-Options", value: "nosniff" },
          // クリックジャッキング対策。cross-origin framing を拒否（実脅威はこれ）。現状 iframe 埋め込みは
          // 無く（signage-preview / signage も直接 render）、将来の同一オリジン埋め込みに前方互換な既定として
          // SAMEORIGIN（DENY と実脅威への防御は同等。同一オリジン framing は攻撃面でない）。
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Referrer 漏洩を最小化（クロスオリジンには origin のみ送出）。
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // 不要なブラウザ機能を無効化しつつ、使う機能だけ自オリジンに許可する（最小権限）。
          // microphone は F02 教員音声入力（Web Speech API、`lib/teacher-input/use-speech-to-text.ts`）が
          // 使う → `microphone=()`（全面禁止）だとブラウザが許可プロンプトを出す前にポリシーで遮断し、
          // 「許可されていない」エラーになるため `microphone=(self)` で自オリジンのみ許可する。
          // camera / geolocation は未使用なので `()` で全面禁止のまま（多層防御 / 最小権限）。
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
          // CSP は **Report-Only**（非ブロッキング）で段階導入する（#591）。違反は devtools console に
          // 報告されるのみで実機能を壊さない。staging 観測で違反ゼロを確認後 `Content-Security-Policy`
          // （enforce）へ昇格する。
          {
            key: "Content-Security-Policy-Report-Only",
            value: CONTENT_SECURITY_POLICY_REPORT_ONLY,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
