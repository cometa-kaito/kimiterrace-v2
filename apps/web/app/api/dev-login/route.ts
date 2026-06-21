import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { isStagingEnv } from "@/lib/auth/app-env";
import { devLoginSignIn, recordDevLoginAudit } from "@/lib/auth/dev-login";
import { toDevLoginRole, verifyDevLoginKey } from "@/lib/auth/dev-login-config";
import { SESSION_COOKIE_NAME, createSessionCookie, verifySessionCookie } from "@/lib/auth/session";

/**
 * GET /api/dev-login — **staging 限定** dev-login（ADR-003 / ADR-032 / ADR-008 Route Handlers）。
 *
 * 運用者 / エージェントが**パスワードを打たずに**教員 / 学校管理者のセッションを得るための、**staging 専用**
 * 開発支援ルート。ブラウザに URL を貼って使えるよう GET にする（`?role=&key=` を受け、成功時はアプリへ
 * リダイレクトしつつ `__session` cookie をセット）。
 *
 * ## prod で認証され得ない根拠（多層防御。CLAUDE.md セキュリティ最優先）
 * 1. **env ゲート（fail-closed）**: `isStagingEnv()`（`APP_ENV === "staging"` のみ true）でなければ **即 404**。
 *    `APP_ENV` 未設定 / 想定外も 404。prod の Cloud Run には `APP_ENV=staging` を配線しない（terraform
 *    envs/staging のみ）ため、prod は常にこの段で 404。
 * 2. **秘密キーゲート（fail-closed）**: `?key=` を staging 限定の `DEV_LOGIN_CONFIG.secret`（Secret Manager・
 *    staging のコンテナのみ）と**定数時間**で突合し、不一致 / config 不在なら **404**。prod には config が
 *    無いため鍵検証は原理的に不能。
 *
 * → どちらか一方が破られても他方が残る。両方を prod に入れない限り機能しない。
 *
 * ## 任意アカウント禁止
 * 受け付けるのは `role=teacher` / `role=admin` のみ。email/uid は一切受け取らず、config に静的に書かれた
 * staging テストアカウントだけをサインインさせる（新規ユーザーは作らない）。
 *
 * ## 列挙対策
 * env / key / role / サインインの失敗はすべて **404 `not_found`** に畳む（このルートの存在自体を秘匿し、
 * どの段で落ちたかを攻撃者に与えない）。
 */

// session cookie 有効期間（/api/auth/session・teacher-login と同値。Identity Platform 上限 14 日）。
const SESSION_EXPIRES_IN_MS = 14 * 24 * 60 * 60 * 1000;

/** このルートの存在を秘匿する統一 404。 */
function notFound(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function GET(request: Request): Promise<NextResponse> {
  // (1) env ゲート: staging 以外（prod 含む・未設定）は即 404（fail-closed）。
  if (!isStagingEnv()) {
    return notFound();
  }

  const url = new URL(request.url);

  // (2) 秘密キーゲート: 定数時間突合。不一致 / config 不在は 404。
  if (!verifyDevLoginKey(url.searchParams.get("key"))) {
    return notFound();
  }

  // role allowlist: teacher / admin のみ。任意ロール・任意 email/uid は受け取らない。
  const role = toDevLoginRole(url.searchParams.get("role"));
  if (!role) {
    return notFound();
  }

  // 既存の認証経路を再利用して本物の idToken を得る（config の staging テストアカウントのみ）。
  const idToken = await devLoginSignIn(role);
  if (!idToken) {
    return notFound();
  }

  let sessionCookie: string;
  try {
    sessionCookie = await createSessionCookie(idToken, SESSION_EXPIRES_IN_MS);
  } catch {
    return notFound();
  }

  // 発行した cookie を検証して actor を解決し、その actor として dev-login 使用を監査記録（RLS context 経由）。
  const user = await verifySessionCookie(sessionCookie);
  if (user) {
    await recordDevLoginAudit(user, role, await headers());
  }

  // 成功: トップへリダイレクト（ルート / がロール別に振り分ける）しつつ session cookie をセット。
  const redirectTo = new URL("/", url.origin);
  const response = NextResponse.redirect(redirectTo, { status: 303 });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: sessionCookie,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_EXPIRES_IN_MS / 1000),
  });
  return response;
}
