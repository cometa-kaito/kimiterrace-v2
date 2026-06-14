import { isRoleAllowed } from "@/lib/auth/guard";
import { getCurrentUser } from "@/lib/auth/session";
import { DRAFT_SECTION_KINDS } from "@/lib/editor/assistant-chat-core";
import { respondWithAssistantChat } from "@/lib/editor/assistant-chat-sse";
import { EDITOR_ROLES, parseEditorTarget, toEditorActor } from "@/lib/editor/schedule-core";

/**
 * 会話型 AI アシスタント（finding 2b）の **SSE route** `POST /api/editor/assistant/chat`。
 *
 * ボディ `{messages, draft?, acknowledgePii?}`（会話履歴 + 現在の下書き）→ AI が「会話応答 + 構造化下書き」を
 * 1 ターン分ストリーミングで返す。編集対象は **クエリ** `?scope=class&targetId=<uuid>`。SSE/HTTP 配線・PII・
 * 監査は {@link respondWithAssistantChat} に委譲し、本 route は **認証 + role gate + target 解決 +
 * 許可セクション解決**に徹する（notice-draft route と同方針）。
 *
 * ## 設計（CLAUDE.md ルール2/4/5）
 * - 認証は `getCurrentUser`（page の `requireRole` は redirect ゆえ API では使わない）: 未認証 401 / role 不足 403 /
 *   target 不正 400 を **JSON で**返す（200 SSE を開く前）。許可 role は {@link EDITOR_ROLES}（teacher / school_admin）。
 * - actor/context はセッション由来（confused-deputy 防止）。許可セクションも**サーバが解決**しクライアントを信用しない。
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

  // 許可セクション解決（finding①）。
  // TODO(PR④ パターン準拠): 実効パターンを `getSignageDesignPattern`（学校レベル既定 + 端末 ?design）と
  // **その他レーンの単一ソース `PATTERN_BLOCKS`** から解決して allowedSections/pattern を決める
  // （pattern2 なら [schedules] 等）。暫定は pattern1 = 全セクション。**AI レーンで独自の pattern→セクション表は
  // 定義しない**（PATTERN_BLOCKS 単一ソースの二重化＝ドリフトを避ける・調整ポイント1）。
  const allowedSections = [...DRAFT_SECTION_KINDS];
  const pattern = "pattern1";

  return respondWithAssistantChat(
    {
      target,
      actor,
      tenantContext: { userId: user.uid, schoolId: actor.schoolId, role: user.role },
      allowedSections,
      pattern,
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
