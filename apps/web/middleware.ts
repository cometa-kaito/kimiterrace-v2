import { type NextRequest, NextResponse } from "next/server";
import { PATHNAME_HEADER } from "./lib/mfa/policy";

/**
 * Edge middleware — 保護ルートのゲート (ADR-003 / ADR-008)。
 *
 * **Edge runtime 制約**: ここでは firebase-admin による session cookie の*暗号検証*も、
 * DB アクセス (RLS context) も行わない。firebase-admin は Node 専用 API (crypto 等) に依存し
 * Edge では動かないため。本 middleware は **cookie の存在チェックのみ** で「未ログインを早期に
 * /login へ弾く」軽量ゲートに徹する。
 *
 * **実検証は Server 側で行う**: 実際の cookie 検証・claims 取り出し・RLS context 確立は
 * Server Component / Route Handler / Server Action から `getCurrentUser()` /
 * `withSession()` (lib/db.ts) を呼んで行う。cookie があっても中身が無効なら、そこで null
 * → 401/redirect になる (deny-by-default は Server 側が最終防衛線)。
 *
 * したがって middleware は「最適化 (無駄な SSR を避ける)」であり「認可の砦」ではない。
 */

const SESSION_COOKIE_NAME = "__session";

export function middleware(request: NextRequest): NextResponse {
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (hasSession) {
    // 認証済みリクエストはそのまま通すが、layout が現在パスを読めるようヘッダを付与する
    // (F11 ADR-031 MFA 強制ゲートのループ防止用、`PATHNAME_HEADER` は lib/mfa/policy.ts が単一ソース)。
    // **リクエストヘッダのみ**を足す純加算的変更で、cookie 検証・redirect 判定・matcher・レスポンスは
    // 一切変えない (既存挙動の不変)。
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(PATHNAME_HEADER, request.nextUrl.pathname);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // 未ログイン: /login へリダイレクト。元の遷移先を ?next= に載せてログイン後に戻せるようにする。
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

/**
 * matcher: 認証不要なパスを除外する。
 * - /login: ログイン画面そのもの
 * - /reset-password: パスワード設定/リセットの自前ページ (oobCode で本人確認)。利用者は **未ログイン**で
 *   開く (発行リンク経由) ため除外しないと /login に弾かれリセットできない。保護データは出さず、可否は
 *   client SDK の `verifyPasswordResetCode`/`confirmPasswordReset` が oobCode で判定する。
 * - /api/auth/*: session 発行・破棄 (未ログインでも叩ける必要がある)
 * - /api/health: 監視用 liveness (ADR: 認証不要)
 * - /s/*: F05 生徒の匿名アクセス入口 (`/s/{token}`)。生徒は `__session` を持たないため
 *   除外しないと route handler に到達できない。可否は token 解決 (resolve_magic_link) が
 *   判定し、失効/期限切れは 410 に倒す (app/s/[token]/route.ts)。
 * - /student: F05 生徒ランディング。`__student_session` で再解決し自己ゲートするため、
 *   教員系 `__session` ゲートからは除外 (app/student/page.tsx)。
 * - /api/student/*: F06 生徒 Q&A チャット SSE (`/api/student/chat`)。生徒は `__session` を持たず
 *   **httpOnly cookie `__student_session`** で認証する匿名経路。除外しないと /login に弾かれチャットが
 *   破綻する。可否は route handler の `resolveStudentSession` (magic link 再解決) が判定し、失効/未設定は
 *   410 Gone (app/api/student/chat/route.ts)。書込は RLS 自校スコープ tx 内のみ (ルール2)。
 * - /signage/*: F12/#48-E 公開サイネージ表示 (`/signage/{classToken}` + `/signage/{classToken}/data`)。
 *   端末は `__session` を持たない匿名公開経路。可否は classToken 解決 (resolve_magic_link) が
 *   判定し、失効/期限切れは無効画面 / 410 に倒す (app/(signage)/...)。除外しないと端末が /login に
 *   弾かれ実機破綻する。`/admin/signage-preview` は `admin` 始まりなので本除外の影響外 (保護のまま)。
 * - /ad-media/*: #46/ADR-037 広告メディアの公開・同一オリジン配信 (`/ad-media/{key}`)。サイネージ端末は
 *   `__session` を持たない匿名公開経路で、広告は公開掲示物 (PII 無し)。除外しないと端末が /login に弾かれ
 *   広告画像が出ない (現状 .png/.jpg は末尾拡張子除外で偶然通るが、video=.mp4 や拡張子規約変更で破綻するため
 *   **明示的に公開経路として除外**する)。可否は route handler の `isValidAdMediaKey` (接頭辞 ads/ + traversal
 *   拒否) が担い、公開バケットの当該接頭辞配下のみ stream する (app/ad-media/[...key]/route.ts)。
 * - /guide, /api/guide/*: F12 (#48-M) フィードバックのガイド画面 + 投稿エンドポイント。教員等が
 *   ログインせずに送れる匿名公開経路 (V1 feedback 受付の移植)。除外しないと未ログインで /login に
 *   弾かれ投稿不能。書き込みは SECURITY DEFINER `submit_feedback` 1 行 INSERT に限定、閲覧は
 *   system_admin のみ (system_admin_only RLS) なので、匿名公開でも閲覧面は漏れない。
 * - /api/partner/*: 効果還元K1 (partner-api-contract §1) portal↔v2 サーバー間 API
 *   (`/api/partner/advertisers/{id}/metrics`)。portal (Vercel) は `__session` を持たない外部 origin の
 *   GET。除外しないと /login に弾かれ K1 (効果メトリクス pull) が破綻する。認可は route handler の
 *   **共有シークレット** (PARTNER_API_SECRET, `Authorization: Bearer` / `x-partner-key`) 検証が担う
 *   (未一致は 401・fail-closed)。/api/tv/ と同型 (外部 origin × 共有シークレット認可)。
 * - /api/tv/*: F15/F16 (ADR-022/ADR-023) TV デバイスのポーリング設定取得 (`/api/tv/config`)。
 *   学校設置の Google TV は `__session` を持たない外部 origin の GET。除外しないと TV が /login に
 *   弾かれポーリング破綻する。認可は **共有シークレット** (`?key=` / TV_POLL_SECRET、ADR-022) を
 *   route handler が検証し (未一致は 401)、device_id→school_id 解決は RLS (system_admin_full_access)
 *   経由で BYPASSRLS 不使用 (ルール2)。将来の死活チェッカ (POST /api/tv/health-check) は **内部呼出
 *   専用**で OIDC/内部シークレット検証 (F16 §6) のため、この匿名除外に同居しても route 側が弾く。
 * - _next/static, _next/image, favicon, public assets: 静的アセット
 *
 * negative lookahead で上記を除外し、残り全部を保護対象にする。匿名公開経路 (F05 の `/s`・
 * `/student`、F12 の `/signage/`・`/guide`) を除外しないと「発行→生徒/端末が開く」「教員がフィードバック
 * 投稿」が /login に弾かれ実機で破綻する (PR #160 Reviewer Critical-1、#48-E)。回帰は
 * __tests__/auth/middleware.test.ts の matcher テスト。
 *
 * **境界の厳格化 (#139 L3)**: prefix 一致の token は `(?:/|$)` で path 境界に縛る。素の `login` /
 * `student` / `api/auth` / `api/health` は前方一致なので、将来の**保護対象**ルート (`/students`,
 * `/api/authority`, `/api/healthcheck`, `/loginland` 等) を**静かにゲート対象外**にし得る (認可は
 * Server 側が最終防衛線だが、middleware 除外の取りこぼしは defense-in-depth を 1 枚剥がす)。
 * `guide` を `guide(?:/|$)` に縛った前例 (PR #227 Reviewer Low-1) と同方針で、残りの prefix token も
 * 境界化する。`s/` / `signage/` / `api/guide/` は末尾 `/` で既に境界済 (例: `s/` は `/settings` に
 * 一致しない)。
 */
export const config = {
  matcher: [
    "/((?!login(?:/|$)|reset-password(?:/|$)|s/|student(?:/|$)|signage/|ad-media/|guide(?:/|$)|api/auth(?:/|$)|api/health(?:/|$)|api/guide/|api/student/|api/partner/|api/tv/|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map|woff|woff2|ttf)$).*)",
  ],
};
