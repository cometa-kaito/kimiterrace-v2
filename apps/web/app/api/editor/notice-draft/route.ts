import { isRoleAllowed } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/auth/session";
import { respondWithNoticeDraftStream } from "@/lib/editor/notice-draft-sse";
import { EDITOR_ROLES, parseEditorTarget, toEditorActor } from "@/lib/editor/schedule-core";

/**
 * 段C+（#243 ②UI-UX, ADR-033）: エディタ AI 連絡ドラフトの **SSE route** `POST /api/editor/notice-draft`。
 *
 * 教員のメモ（ボディ `{text, acknowledgePii?}`）→ AI が「連絡」を **1 件ずつ確定ストリーミング** で返す。
 * 編集対象は **クエリ** `?scope=class&targetId=<uuid>`（school は targetId 不要）で渡す（ボディは handler が
 * 読むため二重読み取りを避ける）。SSE/HTTP 配線・PII・監査は {@link respondWithNoticeDraftStream} に委譲し、
 * 本 route は **認証 + role gate + target 解決** に徹する（teacher chat route #370 と同方針）。
 *
 * ## 設計（CLAUDE.md ルール2/4/5）
 * - **認証は `getCurrentUser`（page の `requireRole` は redirect するため API では使わない）**: 未認証は 401、
 *   role 不足は 403 を **JSON で**返す（200 SSE を開く前）。許可 role は {@link EDITOR_ROLES}（teacher /
 *   school_admin）。
 * - **actor / context はセッション由来（confused-deputy 防止）**: userId / schoolId / role は `getCurrentUser()`
 *   の結果のみから組み立て、リクエストの値は信用しない。schoolId 無し（claims 不整合）は 403。
 * - **target はクエリで解決**: `parseEditorTarget` が scope と UUID を検証（不正は 400）。別テナントの対象は
 *   自校 RLS で不可視（監査 tx は handler の自校 context で張る）。
 * - **middleware**: 教員は `__session` を持つため本 route は通常の `__session` ゲート対象（匿名除外しない）。
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return jsonError(401, "unauthenticated");
  }
  if (!isRoleAllowed(user.role, EDITOR_ROLES)) {
    return jsonError(403, "forbidden");
  }
  const actor = toEditorActor(user);
  if (!actor) {
    // schoolId 無し（壊れたアカウント）。自校スコープが成立しないので deny-by-default。
    return jsonError(403, "forbidden");
  }

  const url = new URL(request.url);
  const target = parseEditorTarget(url.searchParams.get("scope"), url.searchParams.get("targetId"));
  if (!target) {
    return jsonError(400, "invalid_target");
  }

  return respondWithNoticeDraftStream(
    {
      target,
      actor,
      tenantContext: { userId: user.uid, schoolId: actor.schoolId, role: user.role },
    },
    request,
  );
}

/** request-level の拒否を JSON で返す（200 SSE を開く前の 401/403/400 用）。 */
function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
