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
 * - _next/static, _next/image, favicon, public assets: 静的アセット
 *
 * negative lookahead で上記を除外し、残り全部を保護対象にする。
 */
export const config = {
  matcher: [
    "/((?!login|api/auth|api/health|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map|woff|woff2|ttf)$).*)",
  ],
};
