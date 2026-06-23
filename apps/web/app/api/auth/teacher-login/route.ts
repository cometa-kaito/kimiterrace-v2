import { isSameOriginRequest } from "@/lib/auth/csrf";
import { SESSION_COOKIE_NAME, createSessionCookie } from "@/lib/auth/session";
import { teacherLoginFailureLimiter } from "@/lib/auth/teacher-login-rate-limit";
import { authenticateTeacherByPassword } from "@/lib/auth/teacher-login";
import { clientKeyFromHeaders } from "@/lib/guide/rate-limit";
import { createLogger } from "@kimiterrace/observability";
import { NextResponse } from "next/server";

/**
 * POST /api/auth/teacher-login — 教員「学校共通パスワード」ログイン（ADR-032 / ADR-008 Route Handlers）。
 *
 * フロー: 同一オリジン検証 → 失敗回数レート制限（IP）→ **入力パスワードで学校を自動判定して認証**
 * （共通ログイン有効校の共通教員アカウントへ並列に `signInWithPassword`。学校選択は廃止、ADR-032 追補）→
 * 既存の `createSessionCookie` で `__session` cookie 発行。`/api/auth/session` と同じ cookie 属性・有効期間。
 *
 * **CSRF（#139 L2 と同方針）**: body だけで受けるため login CSRF 対象。`isSameOriginRequest` で弾く。
 * **総当たり抑止**: 共通パスワードは短くなりうる（最短 6 文字 = IdP 下限）。**失敗のみ**を IP 単位で数え、閾値超で 429
 * （成功＝正規一斉ログインは非計上。学校 NAT 共有でも誤ブロックしない）。1 リクエスト = 最大 1 失敗計上
 * （自動判定で何校試行しても失敗は 1 件）。volume の最終防壁は WAF/Cloud Armor。
 * **列挙対策**: 学校未有効・パスワード不一致・アカウント不備・**学校間パスワード重複（曖昧）**はすべて
 * 401 `invalid_credentials` に畳む（どの理由かを攻撃者に与えない）。曖昧（`ambiguous`）だけは運用是正のため
 * server log に warn を残す（学校 id のみ・秘密/PII なし）。
 */

// session cookie 有効期間（/api/auth/session と同値。Identity Platform 上限 14 日）。
const SESSION_EXPIRES_IN_MS = 14 * 24 * 60 * 60 * 1000;

const logger = createLogger("teacher-login");

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }

  const nowMs = Date.now();
  const ipKey = clientKeyFromHeaders(request.headers);
  if (teacherLoginFailureLimiter.isBlocked(ipKey, nowMs)) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }

  let password: unknown;
  try {
    const body = (await request.json()) as { password?: unknown };
    password = body.password;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "missing_password" }, { status: 400 });
  }

  // 入力パスワードで学校を自動判定して認証（学校選択レス、ADR-032 追補）。
  const outcome = await authenticateTeacherByPassword(password);
  if (!outcome.ok) {
    if (outcome.reason === "ambiguous") {
      // 学校間で共通パスワードが重複 = どの校か特定不能。安全側で拒否し、運用是正のため warn（学校 id のみ）。
      logger.warn(
        { event: "teacher_login_ambiguous_password", schoolIds: outcome.schoolIds },
        "共通教員パスワードが複数校で重複（曖昧）。テナント越境防止のためログインを拒否。共通PWを全校ユニークに是正すること。",
      );
    }
    // 全失敗（学校なし / 不一致 / 曖昧）を理由を畳んで 401（列挙対策）+ 失敗 1 件計上。
    teacherLoginFailureLimiter.recordFailure(ipKey, nowMs);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  let sessionCookie: string;
  try {
    sessionCookie = await createSessionCookie(outcome.idToken, SESSION_EXPIRES_IN_MS);
  } catch {
    teacherLoginFailureLimiter.recordFailure(ipKey, nowMs);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  // 正規ログイン成功: 当該 IP の失敗カウントを解除（朝の一斉ログインでブロックを残さない）。
  teacherLoginFailureLimiter.clear(ipKey);

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
