import { type NextRequest, NextResponse } from "next/server";

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
    return NextResponse.next();
  }

  // 未ログイン: /login へリダイレクト。元の遷移先を ?next= に載せてログイン後に戻せるようにする。
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

/**
 * matcher: 認証不要なパスを除外する。
 * - /login: ログイン画面そのもの
 * - /api/auth/*: session 発行・破棄 (未ログインでも叩ける必要がある)
 * - /api/health: 監視用 liveness (ADR: 認証不要)
 * - /s/*: F05 生徒の匿名アクセス入口 (`/s/{token}`)。生徒は `__session` を持たないため
 *   除外しないと route handler に到達できない。可否は token 解決 (resolve_magic_link) が
 *   判定し、失効/期限切れは 410 に倒す (app/s/[token]/route.ts)。
 * - /student: F05 生徒ランディング。`__student_session` で再解決し自己ゲートするため、
 *   教員系 `__session` ゲートからは除外 (app/student/page.tsx)。
 * - /api/auth/*: session 発行・破棄 (未ログインでも叩ける必要がある)
 * - /api/health: 監視用 liveness (ADR: 認証不要)
 * - _next/static, _next/image, favicon, public assets: 静的アセット
 *
 * negative lookahead で上記を除外し、残り全部を保護対象にする。F05 の匿名 2 経路
 * (`/s`・`/student`) を除外しないと「発行→生徒が開く」が /login に弾かれ実機で破綻する
 * (PR #160 Reviewer Critical-1)。回帰は __tests__/auth/middleware.test.ts の matcher テスト。
 */
export const config = {
  matcher: [
    "/((?!login|s/|student|api/auth|api/health|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map|woff|woff2|ttf)$).*)",
  ],
};
