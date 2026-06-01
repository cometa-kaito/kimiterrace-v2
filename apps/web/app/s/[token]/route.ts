import { resolveMagicLink } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db";
import { extractClientMeta } from "../../../lib/magic-link/client-meta";
import { recordStudentAccess } from "../../../lib/magic-link/student-access";
import { studentSessionCookie } from "../../../lib/magic-link/student-session";
import { hashToken } from "../../../lib/magic-link/token";

/**
 * F05: 生徒の匿名アクセス入口 `GET /s/{token}` (ADR-008 Route Handlers)。
 *
 * フロー:
 * 1. URL の token を hash 化し `resolve_magic_link` (SECURITY DEFINER) で解決。RLS context は
 *    不要 (生徒は school 未確定)。有効なクラスリンクのみが {id, schoolId, classId} で返る。
 * 2. 失効/期限切れ/不明/非クラス → **410 Gone** (F05: 失効後アクセスは 410)。
 * 3. 有効 → アクセスを events に記録 (IP/UA、ベストエフォート) し、token を httpOnly cookie に
 *    移して URL/履歴から外し、生徒ランディング `/student` へ redirect。以降の有効性は
 *    毎リクエスト再解決で判定する (即時失効、student-session.ts 参照)。
 *
 * token は credential なのでログに出さない (ルール5)。アプリ層だけでなく **infra のアクセスログ**
 * (Cloud Run / LB の request log は `httpRequest.requestUrl` を既定で記録する) も対象で、`/s/{token}`
 * パスは Terraform の `modules/logging` exclusion で既定バケットへ取り込む前に除外する (#439, ADR-016
 * 補完)。生徒アクセスの利用監査は本ハンドラが events に DB 記録するため、HTTP access log の欠落は
 * 監査要件 (ルール1) を損なわない。`getDb()` は非 BYPASSRLS 接続。
 */

function gonePage(): NextResponse {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>リンクが無効です</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center">
<h1>このリンクは使用できません</h1>
<p>リンクが失効したか、有効期限が切れています。担任の先生に新しいリンクの発行を依頼してください。</p>
</body></html>`;
  return new NextResponse(html, {
    status: 410,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  if (!token) {
    return gonePage();
  }

  const resolved = await resolveMagicLink(getDb(), hashToken(token));
  if (!resolved) {
    return gonePage();
  }

  // アクセスログ (events) はベストエフォート: 失敗してもアクセスは通す。
  try {
    await recordStudentAccess(resolved, extractClientMeta(request.headers));
  } catch {
    // 記録失敗はアクセスを妨げない。token はログに出さない (ルール5)。
  }

  const response = NextResponse.redirect(new URL("/student", request.url), 302);
  response.cookies.set(studentSessionCookie(token));
  return response;
}
