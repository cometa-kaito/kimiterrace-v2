import { resolveStudentSession } from "@/lib/magic-link/student-session";
import {
  jsonError,
  resolveStudentQaCookie,
  respondWithChatStream,
} from "@/lib/student-qa/sse-handler";

/**
 * F06 (#42, #371): 生徒対話 Q&A の **SSE route handler** `POST /api/student/chat`。
 *
 * F05 で確立した **httpOnly cookie `__student_session`** から magic link を**サーバ側で再解決**し
 * (`resolveStudentSession`)、自校の公開掲示物を grounding に Vertex Gemini で回答を SSE で逐次返す。
 * SSE/HTTP 配線とオーケストレーションは {@link respondWithChatStream} (sse-handler.ts) に委譲し、本 route は
 * **認証経路 (cookie 解決 → 410)** に徹する。
 *
 * ## なぜ cookie 経由か (旧 `/api/classes/{classToken}/chat` を置換、ルール5)
 * - 生 magic link トークンを **URL path に載せない**。F05 はトークンを URL/履歴/Referer/JS から外すため
 *   httpOnly cookie に移した。トークンを fetch URL の path に入れると **Cloud Run のアクセスログに
 *   credential が残る** (ルール5「ログに secret を出力」)。本 route はトークンに触れず cookie を
 *   `next/headers` でサーバ側解決するため、クライアント JS にもログにもトークンが出ない。
 * - **毎リクエスト再解決**で即時失効 (F05): 失効/期限切れ cookie は `resolveMagicLink` が null を返し
 *   **410 Gone** に倒す (credential はレスポンスに反射しない)。middleware は `__session` (教員系) しか
 *   見ないため、本 anonymous 経路は matcher で除外する (apps/web/middleware.ts の `api/student/`)。
 *
 * 関連: ADR-016 (magic link), ADR-019 (RLS), ADR-028 (回答ポリシー), sse-handler.ts (#371)。
 */
export async function POST(request: Request): Promise<Response> {
  // cookie `__student_session` をサーバ側で再解決 (生トークンは JS/URL/ログに出さない)。
  // 失効/期限切れ/未設定は 410 Gone (credential を反射しない)。
  const resolved = await resolveStudentSession();
  if (!resolved) {
    return jsonError(410, "gone");
  }
  // レート制限の第二キー (kt_qa_cid 端末識別子)。無ければ採番して Set-Cookie する。
  const { cookieId, setCookieHeader } = resolveStudentQaCookie(request);
  return respondWithChatStream(
    {
      // 匿名生徒は school_id のみで RLS tx を張る (user/role なし、ADR-019)。
      tenantContext: { schoolId: resolved.schoolId },
      schoolId: resolved.schoolId,
      identity: {
        kind: "student",
        magicLinkId: resolved.id,
        classId: resolved.classId,
        cookieId,
      },
      setCookieHeader,
    },
    request,
  );
}
