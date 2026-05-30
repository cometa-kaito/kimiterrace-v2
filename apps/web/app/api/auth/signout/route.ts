import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "../../../../lib/auth/session";

/**
 * POST /api/auth/signout — ログアウト (session cookie 破棄、ADR-008 / ADR-003)。
 *
 * cookie を maxAge=0 で上書きしてブラウザから即時削除する。
 *
 * 注: ここでは cookie の削除のみを行う。Identity Platform 側のトークン失効
 * (`revokeRefreshTokens`) はアカウント無効化など強い失効が必要な操作で別途行う想定
 * (ADR-003 の二重チェック思想)。通常ログアウトは cookie 削除で十分。
 */
export function POST(): NextResponse {
  const response = NextResponse.json({ status: "ok" });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
