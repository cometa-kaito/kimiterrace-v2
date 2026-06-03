import { isRoleAllowed } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/auth/session";
import { PUBLISHER_ROLES } from "@/lib/contents/publish-core";
import { jsonError, respondWithChatStream } from "@/lib/student-qa/sse-handler";

/**
 * F06 (#42, #370): 教員 (認証済み) 対話 Q&A の **SSE route handler** `POST /api/teacher/chat`。
 *
 * 教員も生徒と同じ掲示物 Q&A bot を使えるようにする (#370)。生徒経路 (`/api/student/chat`、匿名
 * magic_link) と異なり **Identity Platform セッションで認証**し、自校の公開掲示物を grounding に Vertex
 * Gemini で回答を SSE で逐次返す。SSE/HTTP 配線とオーケストレーションは {@link respondWithChatStream}
 * (sse-handler.ts) に委譲し、本 route は **認証 + role gate** に徹する。
 *
 * ## 設計 (CLAUDE.md ルール2/4/5, ADR-028)
 * - **認証は `getCurrentUser` (page の `requireRole` は redirect するため API では使わない)**: 未認証は
 *   401、role 不足は 403 を **JSON で**返す (200 SSE を開く前)。許可 role は {@link PUBLISHER_ROLES}
 *   (school_admin / teacher)。**system_admin は除外** (単一自校コンテキストを持たない横断ロールで、自校
 *   grounding の対象外。F06 spec の対象 = 生徒 + 教員)。
 * - **user_id は認証済みセッションから導出 (confused-deputy 防止, #514 Reviewer)**: identity.userId /
 *   tenantContext は `getCurrentUser()` の結果のみから組み立て、リクエストボディの値は信用しない。
 *   レート制限は user_id 単一キー (ADR-028)、セッションは user_id キー (#370)。
 * - **RLS (ルール2)**: tenantContext に {userId, schoolId, role} を載せ、RLS 自校スコープ
 *   (tenant_isolation, ADR-019) 下で ai_chat_sessions/messages を読み書きする。手書き WHERE 非依存。
 * - **middleware**: 教員は `__session` を持つため本 route は通常の `__session` ゲート対象 (匿名除外しない)。
 *
 * 関連: ADR-003 (Identity Platform), ADR-019 (RLS), ADR-028 (回答ポリシー), sse-handler.ts, #514 (Slice A)。
 */
export async function POST(request: Request): Promise<Response> {
  // 認証 + role gate を 200 SSE を開く前に実 HTTP で返す (未認証=401 / role 不足=403)。
  const user = await getCurrentUser();
  if (!user) {
    return jsonError(401, "unauthenticated");
  }
  if (!isRoleAllowed(user.role, PUBLISHER_ROLES)) {
    return jsonError(403, "forbidden");
  }
  // PUBLISHER_ROLES (school_admin/teacher) は自校に所属するため school_id を持つ。万一 null
  // (claims 不整合の壊れたアカウント) なら自校 grounding が成立しないので 403 で弾く (deny-by-default)。
  if (!user.schoolId) {
    return jsonError(403, "forbidden");
  }
  // user_id / school_id は認証済みセッションからのみ導出 (外部入力を信用しない、confused-deputy 防止)。
  return respondWithChatStream(
    {
      tenantContext: { userId: user.uid, schoolId: user.schoolId, role: user.role },
      schoolId: user.schoolId,
      identity: { kind: "teacher", userId: user.uid },
    },
    request,
  );
}
