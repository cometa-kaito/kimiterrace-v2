import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, createSessionCookie } from "../../../../lib/auth/session";

/**
 * POST /api/auth/session — ログイン (session cookie 発行、ADR-008 Route Handlers / ADR-003)。
 *
 * フロー (ADR-003):
 * 1. クライアント (app/login) が Identity Platform client SDK でサインイン → ID トークン取得
 * 2. その ID トークンを本ハンドラへ POST
 * 3. Admin SDK で session cookie を発行し、httpOnly cookie として Set-Cookie
 *
 * cookie 属性:
 * - `httpOnly`: JS から読めない (XSS でのトークン窃取を防ぐ)
 * - `secure`: HTTPS のみ (本番 Cloud Run は常に HTTPS。NODE_ENV!=production のローカルのみ false)
 * - `sameSite=lax`: CSRF 緩和。ナビゲーションでは送られるがクロスサイト POST では送られない
 * - `path=/`: 全パスで有効
 */

// session cookie の有効期間。Identity Platform は 5分〜14日を許容。教員系セッションは 5 日。
const SESSION_EXPIRES_IN_MS = 5 * 24 * 60 * 60 * 1000;

export async function POST(request: Request): Promise<NextResponse> {
  let idToken: unknown;
  try {
    const body = (await request.json()) as { idToken?: unknown };
    idToken = body.idToken;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (typeof idToken !== "string" || idToken.length === 0) {
    return NextResponse.json({ error: "missing_id_token" }, { status: 400 });
  }

  let sessionCookie: string;
  try {
    sessionCookie = await createSessionCookie(idToken, SESSION_EXPIRES_IN_MS);
  } catch {
    // ID トークンが無効 / 期限切れ。詳細はログに出さない (トークン断片漏洩防止、ルール5)。
    return NextResponse.json({ error: "invalid_id_token" }, { status: 401 });
  }

  const response = NextResponse.json({ status: "ok" });
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
