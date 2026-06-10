import { isSameOriginRequest } from "@/lib/auth/csrf";
import { SESSION_COOKIE_NAME, createSessionCookie } from "@/lib/auth/session";
import { teacherLoginFailureLimiter } from "@/lib/auth/teacher-login-rate-limit";
import { resolveTeacherLoginSchool, signInSharedTeacher } from "@/lib/auth/teacher-login";
import { clientKeyFromHeaders } from "@/lib/guide/rate-limit";
import { NextResponse } from "next/server";

/**
 * POST /api/auth/teacher-login — 教員「学校共通パスワード」ログイン（ADR-032 / ADR-008 Route Handlers）。
 *
 * フロー: 同一オリジン検証 → 失敗回数レート制限（IP）→ 学校解決（共通ログイン有効校。1 校なら schoolId 不要）→
 * Identity Platform REST `signInWithPassword`（共通教員アカウント、ADR-032）で idToken 取得 →
 * 既存の `createSessionCookie` で `__session` cookie 発行。`/api/auth/session` と同じ cookie 属性・有効期間。
 *
 * **CSRF（#139 L2 と同方針）**: body だけで受けるため login CSRF 対象。`isSameOriginRequest` で弾く。
 * **総当たり抑止**: 共通パスワードは短くなりうる（最短 6 文字 = IdP 下限）。**失敗のみ**を IP 単位で数え、閾値超で 429
 * （成功＝正規一斉ログインは非計上。学校 NAT 共有でも誤ブロックしない）。volume の最終防壁は WAF/Cloud Armor。
 * **列挙対策**: 学校未有効・パスワード不一致・アカウント不備はすべて 401 `invalid_credentials` に畳む
 * （どの理由かを攻撃者に与えない）。学校選択が要る場合のみ 400 `select_required` を返す（UI の分岐用）。
 */

// session cookie 有効期間（/api/auth/session と同値。Identity Platform 上限 14 日）。
const SESSION_EXPIRES_IN_MS = 14 * 24 * 60 * 60 * 1000;

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
  let schoolId: unknown;
  try {
    const body = (await request.json()) as { password?: unknown; schoolId?: unknown };
    password = body.password;
    schoolId = body.schoolId;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "missing_password" }, { status: 400 });
  }
  const sid = typeof schoolId === "string" && schoolId.length > 0 ? schoolId : undefined;

  const resolution = await resolveTeacherLoginSchool(sid);
  if (!resolution.ok) {
    if (resolution.reason === "select_required") {
      // 複数校が共通ログインを提供。UI に学校選択を促す（認証情報は誤りでないので失敗計上しない）。
      return NextResponse.json({ error: "select_required" }, { status: 400 });
    }
    // 学校が共通ログイン無効 = 認証不能。理由を畳んで 401（列挙対策）+ 失敗計上。
    teacherLoginFailureLimiter.recordFailure(ipKey, nowMs);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const idToken = await signInSharedTeacher(resolution.schoolId, password);
  if (!idToken) {
    teacherLoginFailureLimiter.recordFailure(ipKey, nowMs);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  let sessionCookie: string;
  try {
    sessionCookie = await createSessionCookie(idToken, SESSION_EXPIRES_IN_MS);
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
