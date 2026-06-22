import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { isProdLikeEnv, isStagingEnv } from "@/lib/auth/app-env";
import { devLoginSignIn, recordDevLoginAudit } from "@/lib/auth/dev-login";
import {
  getDevLoginKeyVersion,
  toDevLoginRole,
  verifyDevLoginKey,
} from "@/lib/auth/dev-login-config";
import { SESSION_COOKIE_NAME, createSessionCookie, verifySessionCookie } from "@/lib/auth/session";

/**
 * POST /api/dev-login — **staging 限定** dev-login（ADR-003 / ADR-032 / ADR-008 Route Handlers）。
 *
 * 運用者 / エージェントが**パスワードを打たずに**教員 / 学校管理者のセッションを得るための、**staging 専用**
 * 開発支援ルート。成功時は `__session` cookie をセットして 303 でアプリへリダイレクトする。
 *
 * ## なぜ GET ではなく POST + Authorization ヘッダか（秘密キーのログ露出を消す）
 * 旧実装は `?key=<secret>` を URL クエリで受けていたが、クエリは Cloud Run / LB のアクセスログ・ブラウザ履歴・
 * Referer に**平文で残りうる**（ログ閲覧者がキーを再利用して staging セッションを得る横展開リスク）。そこで
 * キーは **`Authorization: Bearer <key>` ヘッダ**で受け、role は body（JSON `{ "role": ... }` or form）で受ける。
 * ヘッダ / body はアクセスログに乗らないため、秘密のログ残留を排除する。
 *
 * ## prod で認証され得ない根拠（多層防御。CLAUDE.md セキュリティ最優先）
 * 0. **prod 打消しゲート（最優先・fail-closed）**: `isProdLikeEnv()` が true（`APP_ENV=prod` や prod プロジェクト
 *    の痕跡）なら、後段の結果に関わらず **即 404**。staging 用 env が prod に誤混入しても、この負ゲートが独立に弾く。
 * 1. **env ゲート（fail-closed）**: `isStagingEnv()`（`APP_ENV === "staging"` のみ true）でなければ **即 404**。
 *    `APP_ENV` 未設定 / 想定外も 404。prod の Cloud Run には `APP_ENV=staging` を配線しない（terraform
 *    envs/staging のみ）ため、prod は常にこの段で 404。
 * 2. **秘密キーゲート（fail-closed）**: Authorization Bearer を staging 限定の `DEV_LOGIN_CONFIG.secret`
 *    （Secret Manager・staging のコンテナのみ）と**定数時間**で突合し、不一致 / config 不在なら **404**。prod に
 *    は config が無いため鍵検証は原理的に不能。
 *
 * → いずれか一つが破られても他が残る。3 層すべてを prod に入れない限り機能しない（= prodAuthPossible=false）。
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

/**
 * Authorization ヘッダから Bearer トークンを取り出す。`Bearer <token>` 以外（欠如・別スキーム・空）は null。
 * 秘密値はここでログに出さない。
 */
function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * リクエスト body から role を取り出す（JSON or x-www-form-urlencoded）。解釈不能 / 欠如は null。
 * 秘密は body に載せない設計なので、parse 失敗は単に role 未指定として扱う。
 */
async function extractRole(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { role?: unknown };
      return typeof body?.role === "string" ? body.role : null;
    }
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      const role = form.get("role");
      return typeof role === "string" ? role : null;
    }
  } catch {
    // 不正 body は role 未指定として扱う（後段で 404）。理由はログに出さない（ルール5）。
    return null;
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  // (0) prod 打消しゲート（最優先）: prod の痕跡が一つでもあれば、他ゲートの結果に関わらず即 404。
  if (isProdLikeEnv()) {
    return notFound();
  }

  // (1) env ゲート: staging 以外（prod 含む・未設定）は即 404（fail-closed）。
  if (!isStagingEnv()) {
    return notFound();
  }

  // (2) 秘密キーゲート: Authorization Bearer を定数時間突合。不一致 / config 不在 / ヘッダ欠如は 404。
  if (!verifyDevLoginKey(extractBearer(request))) {
    return notFound();
  }

  // role allowlist: teacher / admin のみ。任意ロール・任意 email/uid は受け取らない。
  const role = toDevLoginRole(await extractRole(request));
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
    // keyVersion（非秘密のローテ世代ラベル）を diff に残し、濫用調査で鍵世代を追えるようにする。
    await recordDevLoginAudit(user, role, await headers(), getDevLoginKeyVersion());
  }

  // 成功: トップへリダイレクト（ルート / がロール別に振り分ける）しつつ session cookie をセット。
  const origin = new URL(request.url).origin;
  const redirectTo = new URL("/", origin);
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
