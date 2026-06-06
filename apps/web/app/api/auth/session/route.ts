import { NextResponse } from "next/server";
import { isSameOriginRequest } from "../../../../lib/auth/csrf";
import { SESSION_COOKIE_NAME, createSessionCookie } from "../../../../lib/auth/session";

/**
 * POST /api/auth/session — ログイン (session cookie 発行、ADR-008 Route Handlers / ADR-003)。
 *
 * フロー (ADR-003):
 * 1. クライアント (app/login) が Identity Platform client SDK でサインイン → ID トークン取得
 * 2. その ID トークンを本ハンドラへ POST
 * 3. Admin SDK で session cookie を発行し、httpOnly cookie として Set-Cookie
 *
 * **CSRF 防御 (#139 L2)**: idToken を body だけで受けるため login CSRF の対象になりうる。
 * 発行前に `isSameOriginRequest` で Origin/Referer のホストを到達ホストと突合し、クロスサイト
 * POST を 403 で弾く (sameSite=lax への多層防御、lib/auth/csrf.ts)。
 *
 * cookie 属性:
 * - `httpOnly`: JS から読めない (XSS でのトークン窃取を防ぐ)
 * - `secure`: HTTPS のみ (本番 Cloud Run は常に HTTPS。NODE_ENV!=production のローカルのみ false)
 * - `sameSite=lax`: CSRF 緩和。ナビゲーションでは送られるがクロスサイト POST では送られない
 * - `path=/`: 全パスで有効
 */

// session cookie の有効期間。Identity Platform は 5分〜14日を許容。教室 PC でのログイン維持負担を下げる
// ため上限の 14 日に設定する（2026-06-06 ユーザー要望「1ヶ月程」だが IdP 上限が 14 日のため上限を採用。
// 真の 30 日連続はスライディング更新の別実装が必要）。多数の教員が各クラスで個別入力する運用前提。
const SESSION_EXPIRES_IN_MS = 14 * 24 * 60 * 60 * 1000;

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    // クロスサイト POST (login CSRF)。idToken の検証にも進まず即拒否する。
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }

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
